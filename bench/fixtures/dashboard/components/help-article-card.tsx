import type { HelpArticle } from '../lib/types'

export default function HelpArticleCard({ article }: { article: HelpArticle }) {
  return (
    <article className="doc">
      <a href={`/help#${article.id}`} id={article.id}>
        {article.title}
      </a>
      <p className="muted">{article.summary}</p>
      <span className="muted">{article.minutes} min read</span>
    </article>
  )
}
