import { useState } from 'react';
import LOCATIONS from '../data/india-locations.json';
import { Field } from './ui';

const BY_STATE = LOCATIONS as Record<string, string[]>;
const STATES = Object.keys(BY_STATE);

/** The state a city (district) belongs to, so an existing candidate opens with it selected. */
function stateOf(city: string) {
  const c = city.trim().toLowerCase();
  return c ? STATES.find((s) => BY_STATE[s]!.some((d) => d.toLowerCase() === c)) ?? '' : '';
}

/**
 * India State → City. The city list is the chosen state's districts; any other place can still be
 * typed, since the list predates some newer districts. Only the city is stored.
 */
export function LocationPicker({ city, onCity, idPrefix = 'c' }: { city: string; onCity: (city: string) => void; idPrefix?: string }) {
  const [state, setState] = useState(() => stateOf(city));
  const cities = state ? BY_STATE[state]! : [];
  return (
    <>
      <Field id={`${idPrefix}-state`} label="State">
        <select id={`${idPrefix}-state`} value={state} onChange={(e) => { setState(e.target.value); if (stateOf(city) !== e.target.value) onCity(''); }}>
          <option value="">Choose a state</option>
          {STATES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </Field>
      <Field id={`${idPrefix}-city`} label="City" hint={state ? 'Pick from the list or type another place.' : 'Choose the state first, or type the city.'}>
        <input id={`${idPrefix}-city`} list={`${idPrefix}-city-list`} value={city} onChange={(e) => onCity(e.target.value)} autoComplete="off" />
        <datalist id={`${idPrefix}-city-list`}>{cities.map((c) => <option key={c} value={c} />)}</datalist>
      </Field>
    </>
  );
}
