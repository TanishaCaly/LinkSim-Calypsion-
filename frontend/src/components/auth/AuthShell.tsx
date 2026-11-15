import { Fragment, type ReactNode } from 'react'
import './auth.css'

const STEPS = ['Build', 'Run', 'Replay', 'Improve']

// The shared frame of the sign-in and sign-up pages: the dark brand side on the left, the form on the right.
export default function AuthShell({ eyebrow, title, sub, children }: {
  eyebrow: string
  title: string
  sub?: string
  children: ReactNode
}) {
  return (
    <div className="auth min-h-screen">
      <aside className="brand" aria-hidden="true">
        <div className="top">
          <div className="mark">
            <img src="/linksim-mark.png" alt="" style={{ width: 40, height: 40, objectFit: 'contain' }} />
            <div>LinkSim<sup style={{ fontSize: 15, marginLeft: 2, opacity: 0.8, position: 'relative', top: -2 }}>™</sup><small>Manufacturing DES</small></div>
          </div>
          <div className="co">
            <img src="/linksim-mark.png" alt="" />
            <div><small>Powered by</small>Calypsion Innovations</div>
          </div>
        </div>

        <div>
          <div className="copy">
            <h2>Build any line.<br />Simulate anything.<br /><em>Optimize everything.</em></h2>
            <p>Draw a production line, simulate it, and see exactly which station holds everything back.</p>
          </div>
        </div>

        <div className="steps">
          {STEPS.map((s, i) => (
            <Fragment key={s}>
              {i > 0 && <hr />}
              <span>{s}</span>
            </Fragment>
          ))}
        </div>
      </aside>

      <main className="side">
        <div className="box">
          <div className="eyebrow">{eyebrow}</div>
          <h1>{title}</h1>
          {sub && <p className="sub">{sub}</p>}
          {children}
        </div>
        <div className="foot">LinkSim · Powered by <b>Calypsion Innovations</b></div>
      </main>
    </div>
  )
}
