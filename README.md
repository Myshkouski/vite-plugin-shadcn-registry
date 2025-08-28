# vite-plugin-shadcn-registry

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![npm version](https://img.shields.io/npm/v/vite-plugin-shadcn-registry)](https://www.npmjs.com/package/vite-plugin-shadcn-registry)

> **Experimental Notice**  
> ⚠️ This plugin is currently in an experimental phase. Expect breaking changes and major updates in the near future as we work towards a stable release.

A Vite plugin for generating Shadcn components following this schema definitions:
- [registry.json](https://ui.shadcn.com/schema/registry.json)
- [registry-item.json](https://ui.shadcn.com/schema/registry-item.json).

## Features

- Automates Shadcn registry file generation
- Tracks component dependencies and relationships
- Supports Vue/TSX components and composables
- Type-safe TypeScript definitions
- Real-time updates in watch mode

## Installation

```bash
# bun
bun add -D vite-plugin-shadcn-registry
# npm
npm install -D vite-plugin-shadcn-registry
```

## Usage

1. Add plugin to your `vite.config.ts`:

```ts
import { defineConfig } from 'vite'
import shadcnRegistry from 'vite-plugin-shadcn-registry'

export default defineConfig({
  plugins: [
    shadcnRegistry()
  ]
})
```

2. Run your Vite development server:

```bash
bun run dev
```

## Configuration

The plugin generates registry files 

```ts
// TBD
```

## Development

```bash
bun run dev  # Watch mode development
bun run build  # Production build
```

## Contributing

Contributions welcome! Please:

1. Fork the repository
2. Create your feature branch
3. Commit your changes
4. Push to the branch
5. Open a pull request

## License

MIT © [Alexei Myshkouski](https://github.com/myshkouski). See [LICENSE](LICENSE) for details.
