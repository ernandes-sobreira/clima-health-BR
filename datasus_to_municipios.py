#!/usr/bin/env python3
"""
Converte um export do DATASUS/TabNet (SIM - óbitos por município x causa CID-10)
para o registro MUNICIPIOS usado pelo CLIMAQ-H Lite.

ENTRADA esperada (CSV): uma linha por município, com colunas de óbitos ABSOLUTOS
por grupo de causa, mais população. Nomes de coluna flexíveis (mapeados abaixo).

Grupos de causa (CID-10) que o motor usa:
  IHD    = I20-I25
  Stroke = I60-I69
  LRI    = J12-J18, J20-J22
  COPD   = J40-J44, J47
  LC     = C34
  NCD+LRI 25+ (FUSION) = idealmente não-acidentais (A00-R99); se só houver
           all-cause, informe a coluna e o script usa como aproximação (marcado).

SAÍDA: um trecho JS pronto para colar em MUNICIPIOS no app.js.

USO:
  python3 datasus_to_municipios.py meu_export.csv --year 2023 --out municipios.js
"""
import csv, json, argparse, sys, re, unicodedata

# Coordenadas conhecidas (preencha conforme necessário; sem coords o mapa usa 0,0)
COORDS = {
    'Cáceres': (-16.0764, -57.6818),
    'Poconé': (-16.2567, -56.6228),
    'Barão de Melgaço': (-16.1947, -55.9675),
    'Santo Antônio de Leverger': (-15.8656, -56.0781),
    'Cuiabá': (-15.6014, -56.0979),
    'Várzea Grande': (-15.6467, -56.1325),
    'Nossa Senhora do Livramento': (-15.7736, -56.3419),
    'Lambari D\'Oeste': (-15.3239, -58.0011),
    'Curvelândia': (-15.6053, -57.9161),
    'Mirassol d\'Oeste': (-15.6753, -58.0950),
}

# aliases de coluna (normalizados: minúsculo, sem acento/espaço)
ALIASES = {
    'nome':   ['municipio', 'nome', 'localidade'],
    'pop':    ['populacao', 'pop', 'habitantes'],
    'ihd':    ['ihd', 'i20i25', 'isquemica', 'doencaisquemica'],
    'stroke': ['stroke', 'avc', 'i60i69', 'cerebrovascular'],
    'lri':    ['lri', 'alri', 'j12j18', 'infeccaorespiratoria', 'respiratoriainferior'],
    'copd':   ['copd', 'dpoc', 'j40j44'],
    'lc':     ['lc', 'cancerpulmao', 'c34', 'neoplasiapulmao'],
    'allcause': ['todascausas', 'allcause', 'total', 'geral'],
    'nonaccidental': ['naoacidental', 'nonaccidental', 'a00r99'],
}

def norm(s):
    s = unicodedata.normalize('NFKD', str(s)).encode('ascii', 'ignore').decode()
    return re.sub(r'[^a-z0-9]', '', s.lower())

def find_col(headers, keys):
    hn = [norm(h) for h in headers]
    for k in keys:
        for idx, h in enumerate(hn):
            if k in h:
                return idx
    return None

def coords_for(nome):
    """Match por nome normalizado, tolerante a acento/encoding."""
    nn = norm(nome)
    for key, (la, lo) in COORDS.items():
        if norm(key) == nn:
            return la, lo
    return 0.0, 0.0

def to_num(x):
    if x is None: return None
    s = str(x).strip().replace('.', '').replace(',', '.').replace('-', '0')
    try: return float(s)
    except: return None

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('csv')
    ap.add_argument('--year', type=int, required=True, help='ano dos dados DATASUS')
    ap.add_argument('--out', default='municipios.js')
    ap.add_argument('--delimiter', default=';')
    args = ap.parse_args()

    # DATASUS costuma exportar em latin1; tenta utf-8 primeiro, cai para latin1
    raw = open(args.csv, 'rb').read()
    for enc in ('utf-8-sig', 'utf-8', 'latin1'):
        try:
            text = raw.decode(enc); break
        except UnicodeDecodeError:
            continue
    import io
    reader = csv.reader(io.StringIO(text), delimiter=args.delimiter)
    rows = [r for r in reader if any(c.strip() for c in r)]

    headers = rows[0]
    col = {k: find_col(headers, v) for k, v in ALIASES.items()}
    if col['nome'] is None or col['pop'] is None:
        sys.exit('ERRO: não encontrei coluna de município e/ou população. Cabeçalhos: ' + str(headers))

    out = {}
    for r in rows[1:]:
        nome = r[col['nome']].strip()
        if not nome or norm(nome) in ('total', 'ignorado'):
            continue
        pop = to_num(r[col['pop']])
        if not pop or pop <= 0:
            print(f'  aviso: {nome} sem população, pulando')
            continue
        rate = lambda idx: (to_num(r[idx]) / pop * 100000) if idx is not None and to_num(r[idx]) is not None else None
        # baseline NCD+LRI: prefere não-acidental; senão all-cause (aprox., marcado)
        base_idx = col['nonaccidental'] if col['nonaccidental'] is not None else col['allcause']
        base_approx = col['nonaccidental'] is None
        lat, lon = coords_for(nome)
        out[nome] = {
            'nome': nome, 'uf': 'MT', 'pop': int(pop), 'lat': lat, 'lon': lon,
            'dataYear': args.year,
            'source': f'DATASUS/SIM {args.year}, óbitos por causa; pop IBGE'
                      + (' (baseline = all-cause, aproximação)' if base_approx else ''),
            'validated': True,
            'baseAllCause': round(rate(base_idx), 2) if rate(base_idx) is not None else None,
            'mIHD':    round(rate(col['ihd']), 2)    if rate(col['ihd'])    is not None else None,
            'mStroke': round(rate(col['stroke']), 2) if rate(col['stroke']) is not None else None,
            'mLRI':    round(rate(col['lri']), 2)    if rate(col['lri'])    is not None else None,
            'mCOPD':   round(rate(col['copd']), 2)   if rate(col['copd'])   is not None else None,
            'mLC':     round(rate(col['lc']), 2)     if rate(col['lc'])     is not None else None,
        }

    # emite JS: chaveado por nome (sem código IBGE aqui; simples e legível)
    js = 'const MUNICIPIOS = ' + json.dumps(out, ensure_ascii=False, indent=2) + ';\n'
    with open(args.out, 'w', encoding='utf-8') as f:
        f.write(js)
    print(f'OK: {len(out)} municípios -> {args.out}')
    for nome, d in out.items():
        print(f'  {nome}: base={d["baseAllCause"]} IHD={d["mIHD"]} AVC={d["mStroke"]} LRI={d["mLRI"]} DPOC={d["mCOPD"]} LC={d["mLC"]}')

if __name__ == '__main__':
    main()
