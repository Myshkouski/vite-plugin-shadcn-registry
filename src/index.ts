import { kebabCase } from "change-case"
import { fileURLToPath } from "node:url"
import { join as joinPath, relative as relativePath, parse as parsePath, dirname } from 'node:path'
import { createFilter, type Plugin } from "vite"
import type { InputOption, PluginContext, ResolvedId } from "rollup"
import { glob } from "glob"

type ShadcnItemType = RegistryItemType | "registry:shadcn" | "external"
type ShadcnItemMeta = {
  name: string
  type: ShadcnItemType
}
type ShadcnItem = {
  meta: ShadcnItemMeta,
  modules: string[]
  code: string
}

const PLUGIN_NAME = "shadcn-registry"
const SHADCN_REGISTRY_VIRTUAL_MODULE_ID = "\0virtual:shadcn-registry"
const SHADCN_REGISTRY_CHUNK_FILENAME = "shadcn-registry.js"

export default function shadcnRegistry(): Plugin<void> {
  const srcDir = "src"
  const isSourceFile = createFilter([
    joinPath(srcDir, "**")
  ])

  const uiComponentsDir = joinPath(srcDir, "components/ui")
  const uiComponentsGlob = joinPath(uiComponentsDir, "**")
  const isShadcnComponent = createFilter([
    uiComponentsGlob,
  ])

  const componentsDir = joinPath(srcDir, "components")
  const isComponent = createFilter([
    joinPath(componentsDir, "*/index.{js,ts}"),
    joinPath(componentsDir, "*.{vue,jsx,tsx}"),
  ])

  const isUtil = createFilter([
    joinPath(srcDir, "utils", "*"),
  ])

  const composablesDir = joinPath(srcDir, "composables")
  const isComposable = createFilter([
    "src/composables/*.{js,ts}",
    "src/composables/*/index.{js,ts}",
  ])

  let configRootDir: string
  let shadcnEntries: Record<keyof ShadcnComponentConfig["aliases"], Pattern>
  let registry: RegistryImpl

  function getShadcnItemMeta(this: PluginContext, resolvedId: ResolvedId): ShadcnItemMeta {
    const { id: moduleId, external } = resolvedId

    if (isShadcnComponent(moduleId)) {
      return {
        type: "registry:shadcn",
        name: getRegistryItemName(moduleId, configRootDir, uiComponentsDir),
      }
    }

    if (isComponent(moduleId)) {
      return {
        type: "registry:component",
        name: getRegistryItemName(moduleId, configRootDir, componentsDir),
      }
    }

    if (isComposable(moduleId)) {
      return {
        type: "registry:hook",
        name: getRegistryItemName(moduleId, configRootDir, composablesDir),
      }
    }

    if (isUtil(moduleId)) {
      return {
        type: "registry:lib",
        name: getRegistryItemName(moduleId, configRootDir, srcDir),
      }
    }

    if (true === external) {
      return {
        type: "external",
        name: moduleId,
      }
    }

    return {
      type: "registry:internal",
      name: moduleId,
    }
  }

  return {
    name: PLUGIN_NAME,

    options(options) {
      return {
        ...options,
        input: {
          ...convertToInputRecords(options.input),
          "shadcn-registry": SHADCN_REGISTRY_VIRTUAL_MODULE_ID,
        },
      }
    },

    outputOptions(options) {
      return {
        ...options,
        entryFileNames(chunkInfo) {
          if (SHADCN_REGISTRY_VIRTUAL_MODULE_ID == chunkInfo.facadeModuleId) {
            return SHADCN_REGISTRY_CHUNK_FILENAME
          }

          if (!options.entryFileNames) {
            return chunkInfo.name
          }

          if ("function" == typeof options.entryFileNames) {
            return options.entryFileNames(chunkInfo)
          }

          return options.entryFileNames
        }
      }
    },

    configResolved(config) {
      configRootDir = config.root
    },

    async buildStart() {
      const componentsConfig = await importComponentsConfig(configRootDir)
      shadcnEntries = await resolveShadcnEntries.call(this, componentsConfig)
    },

    transform: {
      order: "pre",
      handler(code, moduleId, options) {
        if (isSourceFile(moduleId)) {
          return {
            meta: {
              [PLUGIN_NAME]: {
                sourceCode: code
              }
            }
          }
        }
      }
    },

    resolveId: {
      order: "pre",
      async handler(moduleId, importer, options) {
        if (SHADCN_REGISTRY_VIRTUAL_MODULE_ID == moduleId) {
          return {
            id: moduleId,
          }
        }

        if (true == options.custom?.[PLUGIN_NAME]?.resolveDir) {
          return moduleId
        }
      }
    },

    load(moduleId, options) {
      if (SHADCN_REGISTRY_VIRTUAL_MODULE_ID == moduleId) {
        return {
          moduleType: "js",
          code: `
            ${[
              ...shadcnEntries.components.entries,
              ...shadcnEntries.composables.entries,
              ...shadcnEntries.lib.entries,
              ...shadcnEntries.utils.entries,
            ].map((entry: string) => `import "${entry}";`).join("\n")
            }
          `,
        }
      }
    },

    shouldTransformCachedModule() {
      return false
    },

    async buildEnd() {
      const hoistedImportedIds = getHoistedImportedIds.call(this, SHADCN_REGISTRY_VIRTUAL_MODULE_ID)

      const shadcnItems = new Map<string, ShadcnItem>()

      for (const moduleId of hoistedImportedIds) {

        const resolvedId = await this.resolve(moduleId)
        if (!resolvedId) {
          throw new Error(`Unable to resolve "${moduleId}".`)
        }

        const shadcnItemMeta = getShadcnItemMeta.call(this, resolvedId)

        const moduleInfo = this.getModuleInfo(moduleId)
        if (!moduleInfo) {
          throw new Error(`Unable to find info for module "${moduleId}".`)
        }

        shadcnItems.set(moduleInfo.id, {
          meta: shadcnItemMeta,
          modules: [...moduleInfo.dynamicallyImportedIds, ...moduleInfo.importedIds],
          code: moduleInfo.meta[PLUGIN_NAME]?.sourceCode
        })
      }

      registry = new RegistryImpl("some name", "some homepage")

      for (const [id, shadcnItem] of shadcnItems.entries()) {
        if ("external" == shadcnItem.meta.type) {
          continue
        }
        if ("registry:shadcn" == shadcnItem.meta.type) {
          continue
        }
        if ("registry:internal" == shadcnItem.meta.type) {
          continue
        }

        const {
          files,
          dependencies,
          registryDependencies,
        } = createShadcnItemDependencies.call(this, id, shadcnItems, configRootDir)

        registry.addItem({
          name: shadcnItem.meta.name,
          type: shadcnItem.meta.type,
          files,
          dependencies,
          registryDependencies
        })
      }
    },

    generateBundle(options, bundle) {
      // this.emitFile({
      //   type: "asset",
      //   fileName: `_bundle-keys-${++bundleIndex}.json`,
      //   source: JSON.stringify(Object.keys(bundle))
      // })

      this.emitFile({
        type: "asset",
        fileName: "shadcn-registry/index.json",
        source: JSON.stringify(registry, null, 2)
      })

      for (const item of registry.items) {
        this.emitFile({
          type: "asset",
          fileName: `shadcn-registry/${item.name}.json`,
          source: JSON.stringify({
            $schema: "https://shadcn-vue.com/schema/registry-item.json",
            ...item
          }, null, 2)
        })
      }
    },
  }
}

function getHoistedImportedIds(this: PluginContext, moduleId: string) {
  const hoistedImportedIds = new Set<string>()

  let moduleIdsToProcess = [moduleId]

  while (moduleIdsToProcess.length) {
    moduleIdsToProcess = moduleIdsToProcess.map(id => {
      const moduleInfo = this.getModuleInfo(id)
      if (!moduleInfo) {
        throw new Error(`Unable to find info for module "${moduleId}".`)
      }
      return moduleInfo
    }).flatMap(moduleInfo => {
      const importedIds = [
        ...moduleInfo.importedIds,
        ...moduleInfo.dynamicallyImportedIds,
      ]

      return importedIds
    })

    const nextModuleIdsToProcess = moduleIdsToProcess.filter(id => {
      return false == hoistedImportedIds.has(id)
    })

    moduleIdsToProcess.forEach(id => {
      hoistedImportedIds.add(id)
    })

    moduleIdsToProcess = nextModuleIdsToProcess
  }

  return hoistedImportedIds
}

type ShadcnItemDependencies = Pick<RegistryItem, "dependencies" | "registryDependencies" | "files">
function createShadcnItemDependencies(
  this: PluginContext,
  id: string,
  originalItems: Map<string, ShadcnItem>,
  configRootDir: string
): ShadcnItemDependencies {
  const dependencies = new Set<string>()
  const registryDependencies = new Set<string>()
  const files = new Map<string, RegistryItemFile>()

  const keys = [id, ...originalItems.get(id)?.modules ?? []]
  const entries = [...originalItems.entries()].filter(([id]) => {
    return keys.includes(id)
  })

  let items = new Map(entries)

  while (true) {
    if (!items.size) break

    const nextItems = new Map<string, ShadcnItem>()

    for (const [id, { meta, modules }] of items.entries()) {
      if (id.startsWith("\0")) {
        /**
         * The "\0" prefix, known as a null byte or null character, is a common convention in build tools like Vite and Rollup. 
         * It signifies that the module or identifier is internal and should not be directly processed or bundled by other 
         * plugins or loaders unless explicitly handled.
         * @see https://rollupjs.org/plugin-development/#conventions
         */
        continue
      }

      switch (meta.type) {
        case "external":
          dependencies.add(id)
          break

        case "registry:shadcn":
          registryDependencies.add(meta.name)
          break

        /**
         * @todo  add dependencies for registry:hook, registry:component and registry:lib
         *        instead of adding it as files 
         */
        // case "registry:hook":
        //   registryDependencies.add(`https://my-shadcn-registry.github.io/r/${meta.name}`)
        //   break

        case "registry:internal":
          modules.forEach(dependency => {
            const dependencyItem = originalItems.get(dependency)
            if (!dependencyItem) {
              throw new Error()
            }
            nextItems.set(dependency, dependencyItem)
          })
        // break

        default:
          if (id.includes("?")) break
          const path = getLocalFilePath(id, configRootDir)
          const content = originalItems.get(id)?.code
          // if (path == "src/components/event-calendar/draggable-event.vue") {
          //   console.debug(id)
          //   console.debug(path)
          //   console.debug(content)
          //   console.debug({ ...this.getModuleInfo(id) })
          // }
          files.set(id, {
            type: "registry:file",
            path,
            target: path,
            content,
          })
      }
    }

    items = nextItems
  }

  return {
    dependencies: [...dependencies.values()],
    registryDependencies: [...registryDependencies.values()],
    files: [...files.values()]
  }
}

interface RegistryOperations {
  getItem(name: RegistryItemName): RegistryItem | null
  addItem(item: RegistryItem): void
}

class RegistryImpl implements Registry, RegistryOperations {
  readonly #itemsMap = new Map<RegistryItemName, RegistryItem>()

  constructor(
    readonly name: string,
    readonly homepage: string,
  ) { }

  get items(): RegistryItem[] {
    return [...this.#itemsMap.values()]
  }

  getItem(name: RegistryItemName): RegistryItem | null {
    return this.#itemsMap.get(name) || null
  }

  addItem(item: RegistryItem) {
    this.#itemsMap.set(item.name, item)
  }

  toJSON() {
    return {
      $schema: "https://shadcn-vue.com/schema/registry.json",
      name: this.name,
      homepage: this.homepage,
      items: this.items,
    } satisfies Registry & { $schema: string }
  }
}

function getRegistryItemPath(id: string) {
  return fileURLToPath(new URL(id, "file://"))
}

function getLocalFilePath(id: string, configRootDir: string) {
  const path = getRegistryItemPath(id)
  return relativePath(configRootDir, path)
}

function getRegistryItemName(id: string, configRootDir: string, registryItemType: string) {
  const itemPath = getRegistryItemPath(id)
  const rootDir = joinPath(configRootDir, registryItemType)
  const { dir, name } = parsePath(relativePath(rootDir, itemPath))
  const itemName = kebabCase(dir.replace("/", "") || name)
  return itemName
}

import type { registrySchema, registryItemSchema, registryItemTypeSchema, registryItemFileSchema } from "shadcn-vue/registry"
import { z, type TypeOf } from "zod"
import { stat } from "node:fs/promises"

type Registry = TypeOf<typeof registrySchema>
type RegistryItem = TypeOf<typeof registryItemSchema>
type RegistryItemName = RegistryItem["name"]
type RegistryItemType = TypeOf<typeof registryItemTypeSchema>
type RegistryItemFile = TypeOf<typeof registryItemFileSchema>

const shadcnComponentConfigSchema = z.object({
  aliases: z.object({
    ui: z.string(),
    components: z.string(),
    composables: z.string(),
    utils: z.string(),
    lib: z.string()
  })
})

type ShadcnComponentConfig = TypeOf<typeof shadcnComponentConfigSchema>

async function importComponentsConfig(configRootDir: string) {
  const componentsConfigPath = joinPath(configRootDir, "components.json")
  const { default: componentsConfig } = await import(componentsConfigPath, { with: { type: "json" } })
  return shadcnComponentConfigSchema.parse(componentsConfig)
}

type Pattern = {
  entries: string[]
  include: string | string[]
  ignore: string | string[]
  // match: (id: string) => boolean
}

async function resolveShadcnEntries(this: PluginContext, config: ShadcnComponentConfig) {
  const resolvedAliases: [keyof ShadcnComponentConfig["aliases"], Pattern][] = []

  for (const [name, alias] of Object.entries(config.aliases) as [keyof ShadcnComponentConfig["aliases"], string][]) {
    const resolveDir = false == ["utils"].includes(name)
    const resolvedId = await this.resolve(alias, undefined, {
      // attributs: {
      //   "resolution-mode": "import"
      // },
      custom: {
        [PLUGIN_NAME]: {
          resolveShadcnComponentPaths: true,
          resolveDir,
        }
      }
    })

    if (resolvedId) {
      let path = resolvedId.id
      const pathStats = await stat(path)
      const include = []
      const ignore = []
      if (resolveDir && pathStats.isFile()) {
        path = dirname(path)
      }

      if (resolveDir) {
        const extGlob = ".{js,jsx,ts,tsx,vue}"
        include.push(
          joinPath(alias, "**/*" + extGlob)
        )
        include.push(
          joinPath(path, "*" + extGlob),
          joinPath(path, "*", "index" + extGlob),
        )
        ignore.push(
          joinPath(path, "index" + extGlob),
        )
      } else {
        include.push(
          joinPath(alias)
        )
        include.push(
          joinPath(path),
        )
      }
      resolvedAliases.push([
        name,
        {
          entries: await glob(include, { ignore }),
          include,
          ignore,
        }
      ])
    }
  }

  return Object.fromEntries(resolvedAliases) as Record<keyof ShadcnComponentConfig["aliases"], Pattern>
}

function convertToInputRecords(input: InputOption | undefined) {
  let inputRecords: Record<string, string> = {}

  if ("string" == typeof input) {
    inputRecords = {
      0: input
    }
  } else if (Array.isArray(input)) {
    for (const index in input) {
      inputRecords[index] = input[index]
    }
  } else {
    inputRecords = {
      ...input
    }
  }

  return inputRecords
}
