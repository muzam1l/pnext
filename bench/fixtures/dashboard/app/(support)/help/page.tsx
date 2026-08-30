import Card from '../../../components/card'
import HelpArticleCard from '../../../components/help-article-card'
import PageHeader from '../../../components/page-header'
import { helpSections } from '../../../lib/help'

export default function HelpPage() {
  return (
    <>
      <PageHeader
        title="Help centre"
        description="Short guides for the tasks people ask about most."
      />
      {helpSections.map(section => (
        <Card key={section.section} title={section.section}>
          <div className="card-grid">
            {section.articles.map(article => (
              <HelpArticleCard key={article.id} article={article} />
            ))}
          </div>
        </Card>
      ))}
    </>
  )
}
