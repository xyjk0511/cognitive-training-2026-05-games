import React from 'react'
import { useSearchParams } from 'react-router-dom'
import { GAME_INSTRUCTIONS } from '../../lib/gameInstructions'
import GamePageShell from '../../components/GamePageShell'
import NumberSequence from '../../games/NumberSequence'

export default function NumberSequencePage(): JSX.Element {
  const [search] = useSearchParams()
  const lvl = Number(search.get('level') ?? '1')
  const level = Math.min(Math.max(1, lvl), 10)
  const instructions = GAME_INSTRUCTIONS['number-sequence']

  return (
    <GamePageShell gameId="number-sequence" level={level} instructions={instructions}>
      <NumberSequence level={level} />
    </GamePageShell>
  )
}