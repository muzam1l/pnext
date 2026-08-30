import Card from '../../../components/card'
import PageHeader from '../../../components/page-header'
import SearchResults from '../../../components/search-results'
import { param, type Params } from '../../../lib/paginate'
import { quickLinks, search } from '../../../lib/search'

export default async function SearchPage({ searchParams }: { searchParams: Promise<Params> }) {
  const query = param(await searchParams, 'q') ?? ''
  const hits = search(query)
  return (
    <>
      <PageHeader
        title="Search"
        description={
          query ? `${hits.length} results for “${query}”.` : 'Search across every domain.'
        }
      />
      <Card>
        <form className="toolbar" action="/search">
          <input
            className="input"
            name="q"
            defaultValue={query}
            placeholder="Customers, orders, invoices, stock…"
          />
          <button className="btn btn-primary" type="submit">
            Search
          </button>
        </form>
        {query ? <SearchResults hits={hits} /> : <SearchResults hits={quickLinks} />}
      </Card>
    </>
  )
}
