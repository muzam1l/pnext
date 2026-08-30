import styles from './heatmap.module.css'

interface Cohort {
  label: string
  retention: number[]
}

const shade = (value: number) => `hsl(219 72% ${72 - Math.round(value * 0.42)}%)`

export default function Heatmap({ cohorts, columns }: { cohorts: Cohort[]; columns: number }) {
  return (
    <table className={styles.grid}>
      <thead>
        <tr>
          <th>Cohort</th>
          {Array.from({ length: columns }, (_, index) => (
            <th key={index}>M{index}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {cohorts.map(cohort => (
          <tr key={cohort.label}>
            <th scope="row">{cohort.label}</th>
            {Array.from({ length: columns }, (_, index) => {
              const value = cohort.retention[index]
              return value === undefined ? (
                <td key={index} className={styles.empty} />
              ) : (
                <td key={index} className={styles.cell} style={{ background: shade(value) }}>
                  {value}%
                </td>
              )
            })}
          </tr>
        ))}
      </tbody>
    </table>
  )
}
