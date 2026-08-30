import Card from '../../../components/card'
import ThemeToggle from '../../../components/theme-toggle'

export default function AppearanceSettingsPage() {
  return (
    <Card title="Appearance">
      <p>Pick the theme used across the dashboard.</p>
      <ThemeToggle />
    </Card>
  )
}
