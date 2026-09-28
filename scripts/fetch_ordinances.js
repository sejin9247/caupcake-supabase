// 전국 시·군·특별·광역시 도시(군)계획 조례에서 용도지역별 건폐율·용적률(21종)을 뽑아 JSON으로 저장
// 사용: LAW_OC=<국가법령정보 OPEN API 인증값> node scripts/fetch_ordinances.js <출력.json>
// 인증값은 환경변수로만 읽고 파일·화면에 남기지 않음
const fs = require("fs");
const OC = process.env.LAW_OC;
if (!OC) { console.error("LAW_OC 환경변수가 필요합니다"); process.exit(1); }
const OUT = process.argv[2] || "ordinances.json";
const BASE = "http://www.law.go.kr/DRF";
const sleep = ms => new Promise(r => setTimeout(r, ms));

const ZONES = ["제1종전용주거지역", "제2종전용주거지역", "제1종일반주거지역", "제2종일반주거지역", "제3종일반주거지역", "준주거지역",
  "중심상업지역", "일반상업지역", "근린상업지역", "유통상업지역", "전용공업지역", "일반공업지역", "준공업지역",
  "보전녹지지역", "생산녹지지역", "자연녹지지역", "보전관리지역", "생산관리지역", "계획관리지역", "농림지역", "자연환경보전지역"];
// 국토계획법 시행령 제84조①(건폐율 상한)·제85조①(용적률 하한~상한) — 파싱 결과 검증용
const BCR_MAX = [50, 50, 60, 60, 50, 70, 90, 80, 70, 80, 70, 70, 70, 20, 20, 20, 20, 20, 40, 20, 20];
const FAR_RANGE = [[50, 100], [50, 150], [100, 200], [100, 250], [100, 300], [200, 500], [200, 1500], [200, 1300], [200, 900], [200, 1100],
  [150, 300], [150, 350], [150, 400], [50, 80], [50, 100], [50, 100], [50, 80], [50, 80], [50, 100], [50, 80], [50, 80]];

async function getJSON(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(url); if (r.ok) return await r.json(); } catch {}
    await sleep(800 * (i + 1));
  }
  throw new Error("요청 실패: " + url.replace(OC, "***"));
}

async function listOrdinances() {
  const found = new Map();
  for (const query of ["도시계획 조례", "군계획 조례", "도시·군계획 조례"]) {
    for (let page = 1; page < 20; page++) {
      const j = await getJSON(`${BASE}/lawSearch.do?OC=${OC}&target=ordin&type=JSON&display=100&page=${page}&query=${encodeURIComponent(query)}`);
      let items = j.OrdinSearch?.law || [];
      if (!Array.isArray(items)) items = [items];
      for (const it of items) {
        const name = it["자치법규명"].replace(/\s+/g, " ").trim();
        if (it["자치법규종류"] !== "조례") continue;
        if (!/(도시|군|도시[·ㆍ]군)계획 ?조례$/.test(name)) continue;
        found.set(it["자치법규ID"], { id: it["자치법규ID"], mst: it["자치법규일련번호"], name, org: it["지자체기관명"], eff: it["시행일자"] });
      }
      if (items.length < 100) break;
      await sleep(200);
    }
  }
  return [...found.values()];
}

// 조문 중 「영 제84조제1항」(건폐율) / 「영 제85조제1항」(용적률)을 인용하는 용도지역 조항의 제1항만 읽음
function parseArticle(arts, kind) {
  const cite = kind === "bcr" ? /제84조|제77조/ : /제85조|제78조/;
  const word = kind === "bcr" ? "건폐율" : "용적률";
  // 후보 조문: 제목에 건폐율/용적률 + 본문이 영 제84조/제85조 인용. 「용도지역」 제목·완화 등 없는 제목을 우선
  const score = a => {
    const t = String(a["조제목"] || "");
    return (/용도지역/.test(t) ? 2 : 0) + (/완화|강화|특례|기타/.test(t) ? 0 : 1);
  };
  const cands = arts.filter(a => String(a["조제목"] || "").includes(word) && cite.test(String(a["조내용"] || "")))
    .sort((x, y) => score(y) - score(x));
  for (const a of cands) {
    const body = String(a["조내용"] || "");
    const p1 = body.split(/②/)[0].replace(/\s+/g, "").replace(/<[^>]*>/g, "");
    const vals = {};
    ZONES.forEach(z => {
      // "제2종일반주거지역 : 일반건축은 250퍼센트 이하(다만 …)"처럼 콜론과 숫자 사이의 짧은 수식어는 건너뜀 → 기본값(첫 수치)
      // 수치 표기: 250퍼센트 · 1,200% · 1천500퍼센트 · 1천5백퍼센트 · 100분의80
      const m = p1.match(new RegExp(z + "[^\\d]{0,12}?(?:100분의(\\d+)(\\.)?|([\\d,]*천[\\d,]*(?:백)?|[\\d,]+백|[\\d,]+(?:\\.\\d+)?)(?:퍼센트|%))"));
      if (!m) return;
      if (m[1] === undefined) { vals[z] = parseKoNumber(m[3]); return; }
      // "100분의402.제2종…" = 값 40 + 다음 호 번호 2 가 붙은 경우: 뒤 1~2자리를 떼어 법정 범위 안에 드는 값만 채택
      const i = ZONES.indexOf(z);
      const ok = v => kind === "bcr" ? v > 0 && v <= BCR_MAX[i] : v >= FAR_RANGE[i][0] && v <= FAR_RANGE[i][1];
      let v = Number(m[1]);
      if (m[2] && !ok(v)) for (const k of [1, 2]) {
        const h = m[1].slice(-k), w = Number(m[1].slice(0, -k));
        if (!h.startsWith("0") && ok(w)) { v = w; break; }
      }
      vals[z] = v;
    });
    if (!Object.keys(vals).length) continue;
    const art = body.match(/^제(\d+)조(?:의(\d+))?/);
    return { vals, title: String(a["조제목"] || ""), article: art ? `제${art[1]}조${art[2] ? "의" + art[2] : ""}제1항` : "" };
  }
  return null;
}

function parseKoNumber(raw) {
  let s = raw.replace(/,/g, ""), total = 0, m;
  if ((m = s.match(/^(\d*)천(.*)$/))) { total += Number(m[1] || 1) * 1000; s = m[2]; }
  if ((m = s.match(/^(\d*)백(.*)$/))) { total += Number(m[1] || 1) * 100; s = m[2]; }
  return total + Number(s || 0);
}

function toRows(o, parsed, kind) {
  const rows = [], rejected = [];
  if (!parsed) return { rows, rejected };
  ZONES.forEach((z, i) => {
    const v = parsed.vals[z];
    if (v === undefined) return;
    const ok = kind === "bcr" ? v > 0 && v <= BCR_MAX[i] : v >= FAR_RANGE[i][0] && v <= FAR_RANGE[i][1];
    if (!ok) { rejected.push(`${z} ${kind} ${v}`); return; }
    const eff = `${o.eff.slice(0, 4)}-${o.eff.slice(4, 6)}-${o.eff.slice(6, 8)}`;
    rows.push({
      region: o.org, item: `${z} ${kind === "bcr" ? "건폐율" : "용적률"}`, value: v, unit: "%",
      source: `${o.name} ${parsed.article}(자치법규ID/일련번호 ${o.id} / ${o.mst}, 시행 ${eff}) · 2차자료(국가법령정보 OPEN API)`,
    });
  });
  return { rows, rejected };
}

(async () => {
  const list = await listOrdinances();
  console.error(`조례 ${list.length}건`);
  const out = [], report = [];
  for (const o of list) {
    try {
      const j = await getJSON(`${BASE}/lawService.do?OC=${OC}&target=ordin&MST=${o.mst}&type=JSON`);
      let arts = j.LawService?.["조문"]?.["조"] || [];
      if (!Array.isArray(arts)) arts = [arts];
      const pb = parseArticle(arts, "bcr"), pf = parseArticle(arts, "far");
      const b = toRows(o, pb, "bcr"), f = toRows(o, pf, "far");
      out.push(...b.rows, ...f.rows);
      report.push({ org: o.org, name: o.name, bcr: b.rows.length, far: f.rows.length, rejected: [...b.rejected, ...f.rejected],
                    titles: [pb?.title, pf?.title] });
    } catch (e) { report.push({ org: o.org, name: o.name, error: e.message }); }
    await sleep(150);
  }
  fs.writeFileSync(OUT, JSON.stringify({ queried_on: new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10), rows: out, report }, null, 1));
  console.error(`행 ${out.length}개 → ${OUT}`);
})();
