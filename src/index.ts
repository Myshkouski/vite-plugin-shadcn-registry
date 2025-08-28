import { kebabCase } from "change-case"
import { fileURLToPath } from "node:url"
import { join as joinPath, relative as relativePath, parse as parsePath } from 'node:path'
import { createFilter, type FilterPattern, type Plugin } from "vite"
import type { ModuleInfo, PluginContext } from "rollup"

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
  let registry: RegistryImpl

  function getShadcnItemMeta(moduleInfo: ModuleInfo): ShadcnItemMeta {
    if (isShadcnComponent(moduleInfo.id)) {
      return {
        type: "registry:shadcn",
        name: getRegistryItemName(moduleInfo.id, configRootDir, uiComponentsDir),
      }
    }

    if (isComponent(moduleInfo.id)) {
      return {
        type: "registry:component",
        name: getRegistryItemName(moduleInfo.id, configRootDir, componentsDir),
      }
    }

    if (isComposable(moduleInfo.id)) {
      return {
        type: "registry:hook",
        name: getRegistryItemName(moduleInfo.id, configRootDir, composablesDir),
      }
    }

    if (isUtil(moduleInfo.id)) {
      return {
        type: "registry:lib",
        name: getRegistryItemName(moduleInfo.id, configRootDir, srcDir),
      }
    }

    if (moduleInfo.isExternal) {
      return {
        type: "external",
        name: moduleInfo.id,
      }
    }

    return {
      type: "registry:internal",
      name: moduleInfo.id,
    }
  }

  return {
    name: PLUGIN_NAME,

    configResolved(config) {
      configRootDir = config.root
    },

    async buildStart(options) {
      const componentsConfigPath = joinPath(configRootDir, "components.json")
      const { default: componentsConfig } = await import(componentsConfigPath, { with: { type: "json" } })
      const resolvedAliases = await resolveComponentsConfigAliases.call(this, componentsConfig)
      // console.debug(resolvedAliases)
    },

    // writeBundle(...args) {
    //   console.debug(...args)
    // },

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
      handler(moduleId, importer, options) {
        if (true == options.custom?.[PLUGIN_NAME]?.resolveDir) {
          return moduleId
        }
      }
    },

    load(moduleId, options) {
      // console.debug("[load]", moduleId)
      // if (moduleId == "/root/dev/myshkouski/event-calendar-vue/src/components/event-calendar/draggable-event.vue") {
      //   const moduleInfo = this.getModuleInfo(moduleId)
      //   console.debug("!!!", moduleInfo)
      // }
    },

    shouldTransformCachedModule() {
      return false
    },

    moduleParsed(moduleInfo) {
      // const moduleId = moduleInfo.id
      // if (moduleId == "/root/dev/myshkouski/event-calendar-vue/src/components/event-calendar/draggable-event.vue") {
      //   console.debug({ ...moduleInfo })
      // }
      // if (moduleId == "/root/dev/myshkouski/event-calendar-vue/src/components/event-calendar/draggable-event.vue?vue&type=script&setup=true&lang.ts") {
      //   console.debug(moduleInfo)
      // }
    },

    buildEnd() {
      const shadcnItems = new Map<string, ShadcnItem>()

      for (const moduleId of this.getModuleIds()) {
        const moduleInfo = this.getModuleInfo(moduleId)
        if (!moduleInfo) {
          // TODO: throw error instead?
          continue
        }

        const shadcnItemMeta = getShadcnItemMeta(moduleInfo)
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
          $schema: "https://shadcn-vue.com/schema/registry-item.json",
          name: shadcnItem.meta.name,
          type: shadcnItem.meta.type,
          files,
          dependencies,
          registryDependencies
        })
      }
    },

    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "shadcn-registry/index.json",
        source: JSON.stringify(registry, null, 2)
      })

      for (const item of registry.items) {
        this.emitFile({
          type: "asset",
          fileName: `shadcn-registry/${item.name}.json`,
          source: JSON.stringify(item, null, 2)
        })
      }
    }
  }
}

async function resolveComponentsConfigAliases(this: PluginContext, config: any) {
  const resolvedAliases: [string, { id: string, filter: (patter?: FilterPattern) => boolean }][] = []
  for (const [name, alias] of Object.entries(config.aliases)) {
    const resolveDir = false == ["utils"].includes(name)
    // @ts-expect-error
    const resolvedId = await this.resolve(alias, undefined, {
      custom: {
        [PLUGIN_NAME]: {
          resolveDir
        }
      }
    })
    if (resolvedId) {
      resolvedAliases.push([
        name,
        {
          id: resolvedId.id,
          filter: createFilter(resolveDir ? joinPath(resolvedId.id, "*") : resolvedId.id)
        }
      ])
    }
  }
  return Object.fromEntries(resolvedAliases)
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
import type { TypeOf } from "zod"

type Registry = TypeOf<typeof registrySchema>
type RegistryItem = TypeOf<typeof registryItemSchema>
type RegistryItemName = RegistryItem["name"]
type RegistryItemType = TypeOf<typeof registryItemTypeSchema>
type RegistryItemFile = TypeOf<typeof registryItemFileSchema>
