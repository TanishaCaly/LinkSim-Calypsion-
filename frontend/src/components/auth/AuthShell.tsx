import { Fragment, type ReactNode } from 'react'
import { Cpu } from 'lucide-react'
import flow from './flow.html?raw'
import calypsion from '@/assets/calypsion-logo.png'
import './auth.css'

const STEPS = ['Build', 'Run', 'Replay', 'Improve']

// The shared frame of the sign-in and sign-up pages: the dark brand side on the left, the form on the right.
export default function AuthShell({ eyebrow, title, sub, children }: {
  eyebrow: string
  title: string
  sub: string
  children: ReactNode
}) {
  return (
    <div className="auth min-h-screen">
      <aside className="brand" aria-hidden="true">
        <div className="top">
          <div className="mark">
            <span className="lg"><Cpu size={22} strokeWidth={2} /></span>
            <div>LinkSim<small>Manufacturing DES</small></div>
          </div>
          <div className="co">
            <img src={calypsion} alt="" />
            <div><small>Powered by</small>Calypsion Innovations</div>
          </div>
        </div>

        <div>
          <div className="copy">
            <h2>Run the line<br />before you <em>build it.</em></h2>
            <p>Draw a production line, simulate it, and see exactly which station holds everything back.</p>
          </div>
          <div className="line" dangerouslySetInnerHTML={{ __html: flow }} />
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
          <p className="sub">{sub}</p>
          {children}
        </div>
        <div className="foot">LinkSim · Powered by Calypsion Innovations</div>
      </main>
    </div>
  )
}
