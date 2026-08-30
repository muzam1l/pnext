import type { Metadata } from 'next'
import Button from '../../components/button'
import Card from '../../components/card'

export const metadata: Metadata = { title: 'Sign in · Acme Admin' }

export default function SignInPage() {
  return (
    <Card title="Sign in">
      <form className="form">
        <label>
          Email
          <input className="input" name="email" type="email" />
        </label>
        <label>
          Password
          <input className="input" name="password" type="password" />
        </label>
        <Button type="submit">Sign in</Button>
      </form>
    </Card>
  )
}
