"""Builds india-post-offices.json.gz from the India Post pincode directory.

Source: https://github.com/krs92/go-indian-pincodes (pincodes.json, derived from the India Post
"All India Pincode Directory"). Each row: office name, pincode, taluk (tehsil), district, state.

Cleaning applied here (and nothing else):
- state names to normal spelling; Telangana, Ladakh and the merged Dadra & Nagar Haveli and Daman & Diu
  moved out of their old parent states, because the directory predates those changes;
- tehsil "NA" / "Nil" / blank becomes missing;
- the office-type suffix (B.O branch, S.O sub, H.O head post office) becomes its own column.
District names are the directory's, so districts created after the file was made are not present.
Usage: python3 db/data/build_locations.py /path/to/pincodes.json
"""
import gzip, json, re, sys

src = json.load(open(sys.argv[1]))
STATE = {
    'ANDAMAN & NICOBAR ISLANDS': 'Andaman & Nicobar Islands', 'ANDHRA PRADESH': 'Andhra Pradesh', 'ARUNACHAL PRADESH': 'Arunachal Pradesh', 'ASSAM': 'Assam', 'BIHAR': 'Bihar',
    'CHANDIGARH': 'Chandigarh', 'CHATTISGARH': 'Chhattisgarh', 'DADRA & NAGAR HAVELI': 'Dadra & Nagar Haveli and Daman & Diu', 'DAMAN & DIU': 'Dadra & Nagar Haveli and Daman & Diu',
    'DELHI': 'Delhi', 'GOA': 'Goa', 'GUJARAT': 'Gujarat', 'HARYANA': 'Haryana', 'HIMACHAL PRADESH': 'Himachal Pradesh', 'JAMMU & KASHMIR': 'Jammu & Kashmir', 'JHARKHAND': 'Jharkhand',
    'KARNATAKA': 'Karnataka', 'KERALA': 'Kerala', 'LAKSHADWEEP': 'Lakshadweep', 'MADHYA PRADESH': 'Madhya Pradesh', 'MAHARASHTRA': 'Maharashtra', 'MANIPUR': 'Manipur', 'MEGHALAYA': 'Meghalaya',
    'MIZORAM': 'Mizoram', 'NAGALAND': 'Nagaland', 'ODISHA': 'Odisha', 'PONDICHERRY': 'Puducherry', 'PUNJAB': 'Punjab', 'RAJASTHAN': 'Rajasthan', 'SIKKIM': 'Sikkim', 'TAMIL NADU': 'Tamil Nadu',
    'TRIPURA': 'Tripura', 'UTTAR PRADESH': 'Uttar Pradesh', 'UTTARAKHAND': 'Uttarakhand', 'WEST BENGAL': 'West Bengal',
}
TELANGANA = {'Adilabad', 'Hyderabad', 'K.V.Rangareddy', 'Karim Nagar', 'Khammam', 'Mahabub Nagar', 'Medak', 'Nalgonda', 'Nizamabad', 'Warangal'}
LADAKH = {'Leh', 'Kargil'}
out = []
for r in src:
    state = STATE[r['stateName']]
    district = r['districtName'].strip()
    if r['stateName'] == 'ANDHRA PRADESH' and district in TELANGANA: state = 'Telangana'
    if r['stateName'] == 'JAMMU & KASHMIR' and district in LADAKH: state = 'Ladakh'
    tehsil = (r['taluk'] or '').strip()
    if tehsil.upper() in ('NA', 'NIL', ''): tehsil = None
    name = re.sub(r'\s*\([^)]*\)\s*$', '', r['officeName'].strip())
    m = re.search(r'\s+(EDB\.O|B\.O|S\.O|H\.O|G\.P\.O\.?)$', name)
    kind = 'B'
    if m:
        kind = {'B.O': 'B', 'EDB.O': 'B', 'S.O': 'S', 'H.O': 'H'}.get(m.group(1), 'H')
        name = name[: m.start()]
    out.append([state, district, tehsil, name.strip(), kind, str(r['pincode']).zfill(6)])
out.sort(key=lambda x: (x[0], x[1], x[2] or '', x[3], x[5]))
with gzip.open('db/data/india-post-offices.json.gz', 'wt', encoding='utf-8', compresslevel=9) as f:
    json.dump(out, f, separators=(',', ':'), ensure_ascii=False)
print(len(out), 'offices;', len({x[0] for x in out}), 'states and UTs;', len({(x[0], x[1]) for x in out}), 'districts;', len({(x[0], x[1], x[2]) for x in out if x[2]}), 'tehsils')

# The web form's State -> City lists (web/src/data/india-locations.json): every district and tehsil
# per state, de-duplicated ignoring case:
#   python3 -c "import gzip,json; r=json.load(gzip.open('db/data/india-post-offices.json.gz')); m={}; [m.setdefault(s,{}).setdefault(x.strip().lower(),x.strip()) for s,d,t,*_ in r for x in (d,t) if x and x.strip()]; json.dump({k:sorted(v.values(),key=str.lower) for k,v in sorted(m.items())}, open('web/src/data/india-locations.json','w'), separators=(',',':'), ensure_ascii=False)"
