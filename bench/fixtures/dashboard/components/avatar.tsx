export default function Avatar({ name }: { name: string }) {
  const initials = name
    .split(' ')
    .map(part => part[0])
    .join('')
    .slice(0, 2)
  return <span className="avatar">{initials}</span>
}
