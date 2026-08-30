import type { Page } from '../lib/paginate'

/** Server-rendered page links, so the table slice is chosen before the HTML is built. */
export default function TablePagination({ page, base }: { page: Page; base: string }) {
  const href = (value: number) => `${base}?page=${value}`
  const window = [page.page - 1, page.page, page.page + 1].filter(
    value => value >= 1 && value <= page.pages,
  )
  return (
    <nav className="pagination" aria-label="Pagination">
      <span className="pagination-info">
        {page.start + 1}–{page.end} of {page.total}
      </span>
      <a className="page-link" href={href(1)} aria-disabled={page.page === 1}>
        First
      </a>
      {window.map(value => (
        <a
          key={value}
          className={value === page.page ? 'page-link current' : 'page-link'}
          href={href(value)}
        >
          {value}
        </a>
      ))}
      <a className="page-link" href={href(page.pages)} aria-disabled={page.page === page.pages}>
        Last
      </a>
    </nav>
  )
}
