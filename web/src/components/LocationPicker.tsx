import { useEffect, useState } from 'react';
import { Field } from './ui';

type Places = Record<string, string[]>;
// About 10,000 places: loaded on first use, not with the app.
let cache: Promise<Places> | undefined;
const loadPlaces = () => (cache ??= import('../data/india-locations.json').then((m) => m.default as Places));

/** The state a city belongs to, so an existing candidate opens with it selected. */
function stateOf(places: Places, city: string) {
  const c = city.trim().toLowerCase();
  return c ? Object.keys(places).find((s) => places[s]!.some((d) => d.toLowerCase() === c)) ?? '' : '';
}

/**
 * India State → City. The list is every district and tehsil of the chosen state; any other place can
 * still be typed. Only the city is stored.
 */
export function LocationPicker({ city, onCity, idPrefix = 'c' }: { city: string; onCity: (city: string) => void; idPrefix?: string }) {
  const [places, setPlaces] = useState<Places | null>(null);
  const [state, setState] = useState('');
  useEffect(() => {
    let live = true;
    loadPlaces().then((p) => { if (!live) return; setPlaces(p); setState((s) => s || stateOf(p, city)); });
    return () => { live = false; };
    // Only the city the form opened with picks the initial state.
  }, []);
  const cities = places && state ? places[state] ?? [] : [];
  return (
    <>
      <Field id={`${idPrefix}-state`} label="State">
        <select id={`${idPrefix}-state`} value={state} disabled={!places}
          onChange={(e) => { setState(e.target.value); if (places && stateOf(places, city) !== e.target.value) onCity(''); }}>
          <option value="">{places ? 'Choose a state' : 'Loading…'}</option>
          {places && Object.keys(places).map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </Field>
      <Field id={`${idPrefix}-city`} label="City" hint={state ? `Type to search ${cities.length.toLocaleString('en-IN')} places, or enter another.` : 'Choose the state first, or type the city.'}>
        <input id={`${idPrefix}-city`} list={`${idPrefix}-city-list`} value={city} onChange={(e) => onCity(e.target.value)} autoComplete="off" />
        <datalist id={`${idPrefix}-city-list`}>{cities.map((c) => <option key={c} value={c} />)}</datalist>
      </Field>
    </>
  );
}
