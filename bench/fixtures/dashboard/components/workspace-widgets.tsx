'use client'

import { useMemo, useState } from 'react'
import {
  ActivityIcon,
  ArchiveIcon,
  ChartIcon,
  CheckIcon,
  FilterIcon,
  PlusIcon,
  SearchIcon,
  SettingsIcon,
  UsersIcon,
} from 'fixture-icon-barrel'
import * as Widgets from './generated/widgets'
import type { WorkspaceWidget } from './generated/types'

const widgetEntries = Object.values(Widgets)
const icons = [
  ActivityIcon,
  ArchiveIcon,
  ChartIcon,
  CheckIcon,
  FilterIcon,
  PlusIcon,
  SearchIcon,
  SettingsIcon,
  UsersIcon,
]

export default function WorkspaceWidgets() {
  const [filter, setFilter] = useState('')
  const widgets = useMemo<WorkspaceWidget[]>(
    () =>
      widgetEntries.map((_, index) => ({
        label: `Workspace signal ${index + 1}`,
        value: 900 + index * 37,
        delta: (index % 9) - 4,
        tone: index % 3 === 0 ? 'positive' : index % 3 === 1 ? 'neutral' : 'attention',
      })),
    [],
  )
  const visible = widgets
    .filter(widget => widget.label.toLowerCase().includes(filter.toLowerCase()))
    .slice(0, 24)

  return (
    <section className="workspace-signals">
      <div className="workspace-toolbar">
        <label>
          <SearchIcon /> Search signals
          <input
            value={filter}
            onInput={event => setFilter((event.target as HTMLInputElement).value)}
          />
        </label>
        <button type="button">
          <PlusIcon /> Add signal
        </button>
      </div>
      <div className="workspace-grid">
        {visible.map((widget, index) => {
          const Widget = widgetEntries[index % widgetEntries.length]
          const Icon = icons[index % icons.length]
          return (
            <div key={widget.label} className="workspace-widget-frame">
              <Icon />
              <Widget widget={widget} />
            </div>
          )
        })}
      </div>
    </section>
  )
}
