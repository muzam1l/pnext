import { cycle } from './seed'
import type { HelpArticle } from './types'

const SECTIONS = ['Getting started', 'Billing', 'Security', 'Integrations']
const TITLES = [
  'Invite your first teammate',
  'Understand invoice statuses',
  'Rotate an API key safely',
  'Connect a warehouse feed',
  'Read the retention cohorts',
  'Export a report to CSV',
  'Configure notification channels',
  'Set up single sign-on',
]

export const articles: HelpArticle[] = Array.from({ length: 16 }, (_, index) => ({
  id: `doc_${String(index + 1).padStart(3, '0')}`,
  title: cycle(TITLES, index),
  summary: `A short walkthrough covering ${cycle(TITLES, index).toLowerCase()} end to end.`,
  section: cycle(SECTIONS, index),
  minutes: 2 + (index % 7),
}))

export const helpSections = SECTIONS.map(section => ({
  section,
  articles: articles.filter(article => article.section === section),
}))
