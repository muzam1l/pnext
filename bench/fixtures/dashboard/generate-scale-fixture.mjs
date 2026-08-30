#!/usr/bin/env node
/** Regenerates the committed scale inputs for the dashboard benchmark fixture. */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(fileURLToPath(import.meta.url))
const write = (file, source) => {
  const target = path.join(root, file)
  mkdirSync(path.dirname(target), { recursive: true })
  writeFileSync(target, source)
}
const reset = file => rmSync(path.join(root, file), { recursive: true, force: true })

reset('components/generated')
reset('node_modules/fixture-icon-barrel')
reset('node_modules/fixture-ui-kit')

write(
  'components/generated/types.ts',
  `export type WorkspaceWidget = { label: string; value: number; delta: number; tone: string }\n`,
)
write(
  'components/generated/format.ts',
  `export const compact = (value: number) => new Intl.NumberFormat('en', { notation: 'compact' }).format(value)\n`,
)

const widgets = []
for (let index = 1; index <= 190; index++) {
  const name = `Widget${String(index).padStart(3, '0')}`
  const file = `widget-${String(index).padStart(3, '0')}`
  widgets.push({ name, file })
  write(
    `components/generated/widgets/${file}.tsx`,
    `'use client'\n\nimport { compact } from '../format'\nimport type { WorkspaceWidget } from '../types'\nimport { tone${String((index % 32) + 1).padStart(2, '0')} } from 'fixture-ui-kit'\n\nexport default function ${name}({ widget }: { widget: WorkspaceWidget }) {\n  return (\n    <article className="workspace-widget" data-tone={tone${String((index % 32) + 1).padStart(2, '0')}(widget.tone)}>\n      <span>{widget.label}</span>\n      <strong>{compact(widget.value)}</strong>\n      <small>{widget.delta >= 0 ? '+' : ''}{widget.delta}% this week</small>\n    </article>\n  )\n}\n`,
  )
}
write(
  'components/generated/widgets/index.ts',
  widgets.map(({ name, file }) => `export { default as ${name} } from './${file}'`).join('\n') +
    '\n',
)

const tones = Array.from({ length: 32 }, (_, index) => String(index + 1).padStart(2, '0'))
write(
  'node_modules/fixture-ui-kit/package.json',
  JSON.stringify(
    {
      name: 'fixture-ui-kit',
      version: '0.0.0',
      type: 'module',
      exports: { '.': './dist/index.js' },
      types: './dist/index.d.ts',
    },
    null,
    2,
  ) + '\n',
)
write(
  'node_modules/fixture-ui-kit/dist/index.js',
  tones.map(tone => `export { tone${tone} } from './primitives/tone-${tone}.js'`).join('\n') + '\n',
)
write(
  'node_modules/fixture-ui-kit/dist/index.d.ts',
  tones.map(tone => `export function tone${tone}(value?: string): string`).join('\n') + '\n',
)
for (const tone of tones) {
  write(
    `node_modules/fixture-ui-kit/dist/primitives/tone-${tone}.js`,
    `export const tone${tone} = value => value || 'neutral'\n`,
  )
}
write(
  'node_modules/fixture-ui-kit/dist/styles/components.css',
  Array.from(
    { length: 80 },
    (_, index) => `.fixture-utility-${index + 1} { color: var(--accent); }`,
  ).join('\n') + '\n',
)

write(
  'node_modules/fixture-icon-barrel/package.json',
  JSON.stringify(
    {
      name: 'fixture-icon-barrel',
      version: '0.0.0',
      type: 'module',
      // What every real generated icon catalogue declares; without it a bundler may not drop leaves.
      sideEffects: false,
      exports: { '.': './dist/index.js', './icons/*': './dist/icons/*.js' },
      types: './dist/index.d.ts',
    },
    null,
    2,
  ) + '\n',
)
for (const icon of [
  'activity',
  'archive',
  'chart',
  'check',
  'filter',
  'plus',
  'search',
  'settings',
  'users',
]) {
  const title = icon[0].toUpperCase() + icon.slice(1)
  write(
    `node_modules/fixture-icon-barrel/dist/icons/${icon}.js`,
    `import { createElement } from 'react'\nexport default function ${title}Icon({ size = 16 }) { return createElement('svg', { width: size, height: size, viewBox: '0 0 16 16', 'aria-hidden': true }, createElement('path', { d: 'M2 8h12M8 2v12' })) }\n`,
  )
}
const leafNames = [
  'activity',
  'archive',
  'chart',
  'check',
  'filter',
  'plus',
  'search',
  'settings',
  'users',
]
const barrel = []
for (let index = 1; index <= 18000; index++) {
  const icon = leafNames[(index - 1) % leafNames.length]
  barrel.push(
    `export { default as Icon${String(index).padStart(5, '0')} } from './icons/${icon}.js'`,
  )
}
barrel.push(
  `export { default as ActivityIcon } from './icons/activity.js'`,
  `export { default as ArchiveIcon } from './icons/archive.js'`,
  `export { default as ChartIcon } from './icons/chart.js'`,
  `export { default as CheckIcon } from './icons/check.js'`,
  `export { default as FilterIcon } from './icons/filter.js'`,
  `export { default as PlusIcon } from './icons/plus.js'`,
  `export { default as SearchIcon } from './icons/search.js'`,
  `export { default as SettingsIcon } from './icons/settings.js'`,
  `export { default as UsersIcon } from './icons/users.js'`,
)
write('node_modules/fixture-icon-barrel/dist/index.js', barrel.join('\n') + '\n')
write(
  'node_modules/fixture-icon-barrel/dist/index.d.ts',
  `import type { ComponentType } from 'react'\ntype Icon = ComponentType<{ size?: number }>\nexport const ActivityIcon: Icon\nexport const ArchiveIcon: Icon\nexport const ChartIcon: Icon\nexport const CheckIcon: Icon\nexport const FilterIcon: Icon\nexport const PlusIcon: Icon\nexport const SearchIcon: Icon\nexport const SettingsIcon: Icon\nexport const UsersIcon: Icon\n`,
)
