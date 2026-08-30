export interface Feature {
  title: string
  body: string
}

export const features: Feature[] = [
  { title: 'Server-first', body: 'Pages render on the server and ship as HTML.' },
  { title: 'Islands', body: 'Only the interactive parts become client code.' },
  { title: 'Visible loading', body: 'Offscreen islands stay out of the first bundle.' },
  { title: 'Typed routes', body: 'Route params and search params are generated.' },
  { title: 'Streaming', body: 'Slow sections stream in behind a fallback.' },
  { title: 'No config', body: 'One config file, sensible defaults, no plugins.' },
]

export const logos = ['Northwind', 'Initech', 'Umbrella', 'Hooli']

export interface Testimonial {
  quote: string
  name: string
  role: string
}

export const testimonials: Testimonial[] = [
  {
    quote: 'Our landing page went from 90 KB of JavaScript to almost none.',
    name: 'Ada Reyes',
    role: 'Staff engineer, Northwind',
  },
  {
    quote: 'The calculator only loads when someone scrolls to pricing.',
    name: 'Ben Okafor',
    role: 'Web lead, Initech',
  },
  {
    quote: 'Same components, a fraction of the bundle.',
    name: 'Chen Liu',
    role: 'Frontend, Umbrella',
  },
]

export interface Faq {
  question: string
  answer: string
}

export const faqs: Faq[] = [
  {
    question: 'Is there a free tier?',
    answer: 'Every plan starts with a 14 day trial, no card required.',
  },
  { question: 'Can I change seats later?', answer: 'Seats are prorated on the next invoice.' },
  { question: 'Do you offer yearly billing?', answer: 'Yearly billing saves two months.' },
  { question: 'Where is data stored?', answer: 'In the region you pick when the team is created.' },
  { question: 'Is there an SLA?', answer: 'Business plans include a 99.9% uptime SLA.' },
  { question: 'How do I cancel?', answer: 'From billing settings, effective at the period end.' },
]

export const PLANS = { starter: 12, business: 24 } as const
export type PlanId = keyof typeof PLANS
