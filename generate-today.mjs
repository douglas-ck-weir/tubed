// Runs at midnight UK time via GitHub Actions.
// Replicates the seededRng + station-picking logic from index.html
// and writes today.json for the Devvit Reddit bot to consume.
import { writeFileSync } from 'fs';

const PUZZLE_STATIONS = [
  'Aldgate','Angel','Baker Street','Bank','Barbican','Bond Street','Borough',
  'Cannon Street','Charing Cross','Covent Garden','Edgware Road','Elephant & Castle',
  'Embankment','Euston','Farringdon','Green Park','Holborn','Hyde Park Corner',
  'Kennington','Kings Cross St. Pancras','Knightsbridge','Lambeth North',
  'Lancaster Gate','Leicester Square','Liverpool Street','London Bridge',
  'Mansion House','Marylebone','Monument','Moorgate','Notting Hill Gate',
  'Old Street','Oxford Circus','Paddington','Piccadilly Circus','Pimlico',
  "Regent's Park",'Sloane Square','South Kensington','Southwark',
  "St. James's Park","St. Paul's",'Temple','Tottenham Court Road',
  'Tower Gateway','Tower Hill','Vauxhall','Victoria','Warren Street','Waterloo','Westminster',
  'Bermondsey','Bethnal Green','Brixton','Canada Water','Canary Wharf',
  "Earl's Court",'Highbury & Islington','Mile End','Oval','Stockwell','Whitechapel',
  'Archway','Balham','Barons Court','Belsize Park','Camden Town','Canning Town',
  'Clapham Common','Clapham Junction','Clapham North','Clapham South',
  'Dalston Kingsland','East Putney','Finchley Road','Finsbury Park',
  'Fulham Broadway','Goldhawk Road','Greenwich','Hackney Central','Hammersmith',
  'Hampstead','Highgate','Island Gardens','Kilburn','Lewisham','Limehouse',
  'Mornington Crescent','North Greenwich','Parsons Green',
  'Putney Bridge',"Queen's Park",'Shadwell',"Shepherd's Bush",
  "Shepherd's Bush Market",'Stepney Green','Stratford',
  'Swiss Cottage','Tufnell Park','Turnham Green','West Brompton','West Ham',
  'West Hampstead','White City','Wimbledon',
  'Acton Town','Ealing Broadway','Harrow & Wealdstone','Harrow on the Hill',
  'Richmond','Wembley Park','Wembley Central','Willesden Junction',
  'Chalk Farm','Brent Cross','Colliers Wood','East Finchley','Golders Green','Goodge Street',
  'Chancery Lane',
  'Caledonian Road','Holloway Road','Arsenal',
  'Stamford Brook','Ravenscourt Park','Chiswick Park','West Kensington','Southfields',
  'Preston Road',
  'Willesden Green',"St. John's Wood",
  'Bayswater','Aldgate East','Gloucester Road','High Street Kensington','Latimer Road',
  'Ladbroke Grove','Westbourne Park','Royal Oak','Bow Road',
  'Surrey Quays','New Cross Gate','Crystal Palace',
];

function seededRng(seed) {
  seed = Math.imul(seed ^ seed >>> 16, 0x45d9f3b) | 0;
  seed = Math.imul(seed ^ seed >>> 16, 0x45d9f3b) | 0;
  seed = (seed ^ seed >>> 16) | 0;
  return function() {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function pickStations(mode, now) {
  // Hardcoded freeze for 2026-05-28 easy (matches index.html)
  const dateStr = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
  if (mode === 'easy' && dateStr === '2026-05-28') {
    return { start: 'North Greenwich', end: 'Hammersmith' };
  }

  const baseSeed = now.getFullYear() * 10000 + (now.getMonth()+1) * 100 + now.getDate();
  const seed = mode === 'hard' ? baseSeed + 1 : baseSeed;
  const rng = seededRng(seed);

  // Run the same loop as the browser — just pick start/end indices.
  // We don't have dijkstra here so we replicate the index selection only.
  // The browser validates routes; we trust the RNG produces valid pairs
  // for known-good dates. For safety we pick the first non-identical draw.
  const pool = PUZZLE_STATIONS;
  const si = Math.floor(rng() * pool.length);
  let ei = Math.floor(rng() * pool.length);
  if (ei === si) ei = (ei + 1) % pool.length;
  return { start: pool[si], end: pool[ei] };
}

const now = new Date();
const dateStr = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
const puzzleNum = Math.floor((now.getTime() - new Date('2026-04-03').getTime()) / 86400000) + 1;

const easy = pickStations('easy', now);
const hard = pickStations('hard', now);

const output = {
  date: dateStr,
  puzzleNum,
  easy: { start: easy.start, end: easy.end },
  hard: { start: hard.start, end: hard.end },
};

writeFileSync('today.json', JSON.stringify(output, null, 2));
console.log('today.json written:', output);
