import React, { useId } from 'react'
import agentPetMark from '../assets/agentpet-mark.png'

type AgentPetMarkProps = {
  active?: boolean
  interactive?: boolean
  drawOnce?: boolean
  className?: string
}

export function AgentPetMark({
  active = false,
  interactive = false,
  drawOnce = false,
  className = ''
}: AgentPetMarkProps): React.JSX.Element {
  const drawMaskId = `agentpet-draw-${useId().replace(/:/g, '')}`
  const classes = [
    'agentpet-mark',
    active ? 'agentpet-mark--active' : '',
    drawOnce ? 'agentpet-mark--draw-once' : '',
    interactive ? 'agentpet-mark--interactive' : '',
    className
  ]
    .filter(Boolean)
    .join(' ')

  const artwork = (
    <>
      <img className="agentpet-mark__image" src={agentPetMark} alt="" draggable={false} />
      <svg
        className="agentpet-mark__draw"
        viewBox="0 0 512 512"
        focusable="false"
        aria-hidden="true"
      >
        <defs>
          <mask id={drawMaskId} maskUnits="userSpaceOnUse" x="0" y="0" width="512" height="512">
            <path
              className="agentpet-mark__draw-path"
              pathLength="1"
              d="M 34 276 C 39 237 69 209 113 193 L 333 111 C 380 94 411 119 414 164 L 418 244 C 420 278 445 287 470 270 L 481 263 C 496 293 493 334 474 365 C 463 382 446 394 423 403 L 230 478 C 183 496 153 469 151 423 L 148 360 C 147 329 125 315 100 327 L 58 347"
              fill="none"
              stroke="white"
              strokeWidth="280"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </mask>
        </defs>
        <image
          href={agentPetMark}
          width="512"
          height="512"
          preserveAspectRatio="xMidYMid meet"
          mask={`url(#${drawMaskId})`}
        />
      </svg>
    </>
  )

  return (
    <span className={classes} aria-hidden="true">
      {artwork}
    </span>
  )
}
