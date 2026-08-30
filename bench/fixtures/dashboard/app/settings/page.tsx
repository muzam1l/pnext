import Card from '../../components/card'
import ProfileForm from '../../components/profile-form'

export default function ProfileSettingsPage() {
  return (
    <Card title="Profile">
      <ProfileForm name="Ada Lovelace" email="ada@example.com" />
    </Card>
  )
}
