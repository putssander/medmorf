// metrics.js — scoring helpers for tests/test-models.html.
// Pure functions, no DOM. Kept dependency-free so they run in any browser.

// ── Text normalisation ────────────────────────────────────────────────────────

export function normalizeText(s, aliases = {}) {
    let t = String(s || '').toLowerCase();
    // Apply aliases: every alias variant collapses to the canonical key.
    for (const [canon, variants] of Object.entries(aliases)) {
        for (const v of variants) {
            t = t.split(String(v).toLowerCase()).join(canon.toLowerCase());
        }
    }
    t = t.normalize('NFD').replace(/[̀-ͯ]/g, ''); // strip diacritics
    t = t.replace(/[^\p{L}\p{N}\s%]/gu, ' ');                // drop punctuation
    return t.replace(/\s+/g, ' ').trim();
}

// ── Word Error Rate (speech) ──────────────────────────────────────────────────

export function wer(reference, hypothesis, aliases = {}) {
    const r = normalizeText(reference, aliases).split(' ').filter(Boolean);
    const h = normalizeText(hypothesis, aliases).split(' ').filter(Boolean);
    const d = levenshtein(r, h);
    return { wer: r.length ? d / r.length : (h.length ? 1 : 0), edits: d, refWords: r.length };
}

function levenshtein(a, b) {
    const m = a.length, n = b.length;
    let prev = new Array(n + 1);
    let cur = new Array(n + 1);
    for (let j = 0; j <= n; j++) prev[j] = j;
    for (let i = 1; i <= m; i++) {
        cur[0] = i;
        for (let j = 1; j <= n; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
        }
        [prev, cur] = [cur, prev];
    }
    return prev[n];
}

// ── chrF (translation) ────────────────────────────────────────────────────────
// Popović 2015. Character n-grams 1..6, β=2 (recall-weighted). Returns 0..1.

export function chrF(reference, hypothesis, { n = 6, beta = 2 } = {}) {
    const ref = String(reference || '').toLowerCase().replace(/\s+/g, ' ').trim();
    const hyp = String(hypothesis || '').toLowerCase().replace(/\s+/g, ' ').trim();
    if (!ref || !hyp) return 0;
    let precSum = 0, recSum = 0, count = 0;
    for (let k = 1; k <= n; k++) {
        const rg = ngramCounts(ref, k), hg = ngramCounts(hyp, k);
        let match = 0, hTotal = 0, rTotal = 0;
        for (const [g, c] of hg) { hTotal += c; match += Math.min(c, rg.get(g) || 0); }
        for (const c of rg.values()) rTotal += c;
        if (hTotal === 0 || rTotal === 0) continue;
        precSum += match / hTotal;
        recSum += match / rTotal;
        count++;
    }
    if (!count) return 0;
    const P = precSum / count, R = recSum / count;
    if (P + R === 0) return 0;
    const b2 = beta * beta;
    return (1 + b2) * P * R / (b2 * P + R);
}

function ngramCounts(s, k) {
    const m = new Map();
    for (let i = 0; i + k <= s.length; i++) {
        const g = s.slice(i, i + k);
        m.set(g, (m.get(g) || 0) + 1);
    }
    return m;
}

// ── PII detection (anonymize) ─────────────────────────────────────────────────
// groundTruth: [{text, type}], predictions: [{entity, type}], allowed: [string]

// Whole-word overlap either way: "Noor" matches "dochter Noor" but not
// "Noorderlicht"; "Driebergen" matches "Driebergen-Rijsenburg" (punctuation is
// normalised to spaces). Comparison is case- and diacritic-insensitive.
function containsWords(hay, needle) {
    return (' ' + hay + ' ').includes(' ' + needle + ' ');
}
function overlaps(a, b) {
    const x = normalizeText(a), y = normalizeText(b);
    if (!x || !y) return false;
    return containsWords(x, y) || containsWords(y, x);
}
// Every content token of `pred` (≥3 chars, or numeric) occurs as a word in
// `phrase`. Used for descriptive gold elements such as "vader van 79 woont in
// Gouda", which a detector neutralises by flagging "79" or "Gouda".
function tokensSubset(pred, phrase) {
    const words = new Set(normalizeText(phrase).split(' '));
    const toks = normalizeText(pred).split(' ').filter(t => t.length >= 3 || /^\d+$/.test(t));
    return toks.length > 0 && toks.every(t => words.has(t));
}

export function scorePII(groundTruth, predictions, allowed = []) {
    const preds = (predictions || []).map(p => ({ entity: String(p.entity ?? p.word ?? '').trim(), type: String(p.type ?? p.entity_group ?? '') })).filter(p => p.entity);
    const perType = {};
    const missed = [];
    let detected = 0;
    for (const gt of groundTruth) {
        const hit = preds.some(p => overlaps(p.entity, gt.text));
        perType[gt.type] ??= { total: 0, detected: 0 };
        perType[gt.type].total++;
        if (hit) { perType[gt.type].detected++; detected++; }
        else missed.push(gt);
    }
    const falsePositives = preds.filter(p =>
        !groundTruth.some(gt => overlaps(p.entity, gt.text)) &&
        !allowed.some(a => overlaps(p.entity, a))
    );
    const recall = groundTruth.length ? detected / groundTruth.length : 1;
    const precision = preds.length ? (preds.length - falsePositives.length) / preds.length : 1;
    const f1 = precision + recall ? 2 * precision * recall / (precision + recall) : 0;
    return { recall, precision, f1, detected, total: groundTruth.length, missed, falsePositives, perType, predictions: preds.length };
}

// ── Re-identification risk (anonymize, optional per document) ────────────────
// doc.riskGroups: [{ id, level, category, elements: [string], reason, action }]
//   Elements are gold quasi-identifier phrases (not always verbatim). An element
//   is *neutralised* when some prediction overlaps it or is a sub-phrase of it.
//   quasiRecall   = neutralised elements / all elements.
//   groupCoverage = share of groups with at least half their elements neutralised
//                   (ceil(n/2)); a heuristic for "enough components removed",
//                   the per-group counts are returned for finer reading.
// doc.retain: [string] clinical concepts that must survive de-identification.
//   A concept is *lost* when any prediction overlaps it (it would be replaced).
//   overRedactionRate = lost / all; retention = 1 − overRedactionRate.
export function scoreReidentification(doc, predictions) {
    const preds = (predictions || []).map(p => String(p.entity ?? p.word ?? '').trim()).filter(Boolean);
    const hit = (phrase) => preds.some(p => overlaps(p, phrase) || tokensSubset(p, phrase));
    const groups = (doc.riskGroups || []).map(g => {
        const elements = (g.elements || []).map(e => (typeof e === 'string' ? e : String(e.text ?? '')));
        const detected = elements.filter(hit);
        const need = Math.ceil(elements.length / 2);
        return { id: g.id, level: g.level, category: g.category, total: elements.length, detected: detected.length, covered: elements.length > 0 && detected.length >= need, missed: elements.filter(e => !detected.includes(e)) };
    });
    const elementsTotal = groups.reduce((n, g) => n + g.total, 0);
    const elementsDetected = groups.reduce((n, g) => n + g.detected, 0);
    const retain = doc.retain || [];
    const lost = retain.filter(c => preds.some(p => overlaps(p, c) || tokensSubset(p, c)));
    return {
        quasiRecall: elementsTotal ? elementsDetected / elementsTotal : null,
        elementsDetected, elementsTotal,
        groupCoverage: groups.length ? groups.filter(g => g.covered).length / groups.length : null,
        groupsCovered: groups.filter(g => g.covered).length, groupsTotal: groups.length,
        perGroup: groups,
        overRedactionRate: retain.length ? lost.length / retain.length : null,
        retention: retain.length ? 1 - lost.length / retain.length : null,
        lostConcepts: lost, retainTotal: retain.length,
    };
}

// Entity-level score plus, when the document carries risk groups or a retain
// list, the re-identification score under `reid`.
export function scoreAnonDoc(doc, predictions) {
    const score = scorePII(doc.pii, predictions, doc.allowed);
    if ((doc.riskGroups && doc.riskGroups.length) || (doc.retain && doc.retain.length)) score.reid = scoreReidentification(doc, predictions);
    return score;
}

// ── Fact coverage (summarize) ─────────────────────────────────────────────────

export function scoreFacts(summary, facts = [], forbidden = []) {
    const s = normalizeText(summary);
    const has = (kw) => s.includes(normalizeText(kw));
    const covered = facts.filter(f => f.any.some(has));
    const hallucinated = forbidden.filter(f => f.any.some(has));
    return {
        coverage: facts.length ? covered.length / facts.length : 1,
        covered: covered.length,
        total: facts.length,
        missed: facts.filter(f => !f.any.some(has)).map(f => f.label),
        hallucinations: hallucinated.map(f => f.label),
        hallucinationRate: forbidden.length ? hallucinated.length / forbidden.length : 0,
    };
}

// ── Aggregation ───────────────────────────────────────────────────────────────

export function mean(xs) {
    const a = xs.filter(x => typeof x === 'number' && isFinite(x));
    return a.length ? a.reduce((p, c) => p + c, 0) / a.length : NaN;
}
