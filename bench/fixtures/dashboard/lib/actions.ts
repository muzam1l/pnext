'use server'

export async function saveProfile(input: { name: string; email: string }) {
  await Promise.resolve() // Stands in for the write a real action would await.
  return { ok: true, savedAt: new Date().toISOString(), name: input.name, email: input.email }
}

export async function inviteMember(input: { email: string; role: string; message: string }) {
  await Promise.resolve()
  return {
    ok: input.email.includes('@'),
    email: input.email,
    role: input.role,
    message: input.message,
  }
}
