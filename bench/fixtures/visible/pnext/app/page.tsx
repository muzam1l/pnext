import { dynamic } from '@wular/pnext/dynamic'
import { faqs, features, logos, testimonials } from '../lib/content'

// The tier under test: the island is not in the first-page bundle at all.
const PricingCalculator = dynamic(() => import('./pricing-calculator'), {
  load: 'visible',
  rootMargin: '200px',
})

export const metadata = {
  lang: 'en',
  title: 'Nimbus — ship the interface, not the bundle',
  description: 'A landing page with one below-the-fold island.',
}

export default function LandingPage() {
  return (
    <main>
      <section className="hero">
        <h1>Ship the interface, not the bundle</h1>
        <p>Server-rendered above the fold. One island, loaded when it is seen.</p>
      </section>

      <section className="section" id="features">
        <h2>Features</h2>
        <div className="grid">
          {features.map(feature => (
            <article className="card" key={feature.title}>
              <h3>{feature.title}</h3>
              <p>{feature.body}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="section">
        <h2>Trusted by</h2>
        <ul className="logos">
          {logos.map(logo => (
            <li key={logo}>{logo}</li>
          ))}
        </ul>
      </section>

      <section className="section">
        <h2>What teams say</h2>
        <div className="grid">
          {testimonials.map(testimonial => (
            <blockquote className="card" key={testimonial.name}>
              <p>{testimonial.quote}</p>
              <cite>
                {testimonial.name} — {testimonial.role}
              </cite>
            </blockquote>
          ))}
        </div>
      </section>

      <section className="section pricing-section" id="pricing">
        <h2>Pricing</h2>
        <PricingCalculator />
      </section>

      <section className="section" id="faq">
        <h2>Questions</h2>
        {faqs.map(faq => (
          <details key={faq.question}>
            <summary>{faq.question}</summary>
            <p>{faq.answer}</p>
          </details>
        ))}
      </section>
    </main>
  )
}
