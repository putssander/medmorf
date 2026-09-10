// anonymize-filters.js
// Deterministic post-filters for PII detector output, shared by the Anonymize
// pipeline (src/anonymize-handler.js) and the Benchmark tab
// (src/benchmark-handler.js) so benchmark precision reflects what the app
// really keeps. Pure functions, no DOM.
//
// - isObviousGarbage: roles, labels and common words no detector should flag
//   (applied to GLiNER output and to LLM output).
// - filterLLMEntities: normalises LLM type labels, dedupes, drops anything that
//   is not a verbatim quote of the chunk and anything that cannot be an
//   identifier of its type. Never drops a value that could be PII.

export function createDetectionKey(entity, type) {
    return `${entity.trim().toLowerCase()}::${type}`;
}

// Pre-filter obvious GLiNER false positives that no LLM review is needed for
export function isObviousGarbage(entity, type, { requireCapitals = true } = {}) {
    const lower = entity.toLowerCase().replace(/\s+/g, ' ').trim();

    // Single words that are never PII regardless of type
    const commonWords = new Set([
        'ja', 'nee', 'ok', 'oké', 'goed', 'prima', 'dank', 'dank u', 'bedankt',
        'hallo', 'dag', 'goedemorgen', 'goedemiddag', 'goedenavond',
        'wat', 'wie', 'waar', 'wanneer', 'hoe', 'waarom',
        'mij', 'mijn', 'uw', 'u', 'hij', 'zij', 'wij', 'hun', 'hem', 'haar',
        'twee', 'drie', 'vier', 'vijf', 'zes', 'zeven', 'acht', 'negen', 'tien',
        'patiënt', 'patiënte', 'pati', 'patient',
        'noodgevallen', 'vermoeidheid', 'klachten', 'medicatie', 'behandeling',
        'contactpersoon', 'contactgegevens', 'rijbewijsnummer', 'telefoonnummer',
        'mijn vrouw', 'mijn man', 'mijn huisarts', 'mijn zoon', 'mijn dochter',
        'mijn iban', 'mijn bsn',
        // Roles, titles and relationship words: never PII on their own
        'interviewer', 'arts', 'huisarts', 'dokter', 'dr', 'dr.', 'drs', 'drs.',
        'mevrouw', 'meneer', 'mevr', 'mevr.', 'mw', 'mw.', 'dhr', 'dhr.',
        'cliënt', 'cliënte', 'client', 'bewoner', 'verpleegkundige', 'specialist',
        'cardioloog', 'psychiater', 'psycholoog', 'therapeut', 'apotheker',
        'zorgverzekeraar', 'werkgever', 'school', 'ziekenhuis', 'kliniek', 'praktijk', 'apotheek',
        'het ziekenhuis', 'de huisarts', 'de school', 'de praktijk', 'de kliniek', 'de apotheek',
        'de basisschool', 'basisschool', 'thuis', 'het werk', 'de arts', 'de dokter', 'de specialist',
        'mijn moeder', 'mijn vader', 'mijn ouders', 'mijn partner', 'mijn broer', 'mijn zus',
        'mijn kinderen', 'mijn werkgever', 'echtgenote', 'echtgenoot', 'partner',
        'moeder', 'vader', 'zoon', 'dochter', 'broer', 'zus', 'kinderen', 'ouders',
        'patient', 'doctor', 'nurse', 'gp', 'physician', 'hospital', 'clinic', 'employer', 'insurer',
        'the hospital', 'the clinic', 'the doctor', 'my wife', 'my husband', 'my mother', 'my father',
        'wife', 'husband', 'mother', 'father', 'son', 'daughter',
        // Field labels the model sometimes returns instead of the value
        'naam', 'adres', 'geboortedatum', 'telefoon', 'telefoonnummer', 'e-mail', 'email',
        'bsn', 'iban', 'polisnummer', 'geboren', 'name', 'address', 'date of birth', 'phone',
    ]);
    if (commonWords.has(lower)) return true;

    // ID_NUMBER: must contain at least one digit to be a real identifier
    if (type === 'ID_NUMBER' && !/\d/.test(entity)) return true;

    // LOCATION: must look like a place name (capitalized) or address, not a common word
    if (type === 'LOCATION' && entity.length < 3 && !/\d/.test(entity)) return true;

    // Phrases that are clearly conversational, not PII
    if (/^(kunt u|heeft u|ik ben|ik heb|wilt u|mag ik|kan ik)\b/i.test(lower)) return true;

    // Multi-word phrases that don't contain any capitalized word (likely not a name/place)
    if (requireCapitals && (type === 'PERSON' || type === 'ORGANIZATION') && entity.split(/\s+/).length > 1) {
        const hasCapital = entity.split(/\s+/).some(w => /^[A-Z\u00C0-\u024F]/.test(w));
        if (!hasCapital) return true;
    }

    return false;
}

// ── LLM output sanity filters ─────────────────────────────────────────────────
// Small LLMs return type labels in many spellings and, despite the prompt,
// paraphrase spans or list roles/common words. Everything below is
// deterministic and only drops values that cannot be identifiers or that do
// not occur in the chunk (those could never be replaced anyway — they only
// clutter the mapping). Dropped items are shown in the results panel.
const LLM_TYPE_ALIASES = {
    PERSON: 'PERSON', NAME: 'PERSON', PER: 'PERSON', PATIENT: 'PERSON', DOCTOR: 'PERSON', PERSON_NAME: 'PERSON',
    LOCATION: 'LOCATION', LOC: 'LOCATION', CITY: 'LOCATION', COUNTRY: 'LOCATION', PLACE: 'LOCATION', GPE: 'LOCATION', REGION: 'LOCATION',
    DATE: 'DATE', TIME: 'DATE', DATETIME: 'DATE', BIRTHDATE: 'DATE', BIRTH_DATE: 'DATE', DOB: 'DATE', DATE_OF_BIRTH: 'DATE',
    PHONE: 'PHONE', PHONE_NUMBER: 'PHONE', TELEPHONE: 'PHONE', FAX: 'PHONE', MOBILE: 'PHONE', TEL: 'PHONE',
    EMAIL: 'EMAIL', EMAIL_ADDRESS: 'EMAIL', MAIL: 'EMAIL',
    ADDRESS: 'ADDRESS', STREET: 'ADDRESS', STREET_ADDRESS: 'ADDRESS', POSTAL_CODE: 'ADDRESS', POSTCODE: 'ADDRESS', ZIP: 'ADDRESS', ZIP_CODE: 'ADDRESS', ZIPCODE: 'ADDRESS',
    ORGANIZATION: 'ORGANIZATION', ORGANISATION: 'ORGANIZATION', ORG: 'ORGANIZATION', COMPANY: 'ORGANIZATION', HOSPITAL: 'ORGANIZATION', EMPLOYER: 'ORGANIZATION', SCHOOL: 'ORGANIZATION', INSURER: 'ORGANIZATION', INSURANCE: 'ORGANIZATION',
    ID_NUMBER: 'ID_NUMBER', ID: 'ID_NUMBER', IDENTIFIER: 'ID_NUMBER', BSN: 'ID_NUMBER', SSN: 'ID_NUMBER', IBAN: 'ID_NUMBER', PATIENT_ID: 'ID_NUMBER', MRN: 'ID_NUMBER', INSURANCE_NUMBER: 'ID_NUMBER', POLICY_NUMBER: 'ID_NUMBER', LICENSE: 'ID_NUMBER', LICENSE_NUMBER: 'ID_NUMBER', NUMBER: 'ID_NUMBER',
    AGE: 'AGE',
};

export function normalizeLLMType(raw) {
    const key = String(raw || '').trim().toUpperCase().replace(/[\s-]+/g, '_');
    return LLM_TYPE_ALIASES[key] || key || 'MISC';
}

export function normalizeForMatch(s) {
    return String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

// Trim quotes/brackets and trailing sentence punctuation the model sometimes
// copies along with the value. A trailing "." is kept after an initial or an
// abbreviation ("J.P.", "B.V.") — only dropped after a lowercase letter.
export function cleanLLMEntityText(raw) {
    let t = String(raw || '').replace(/\s+/g, ' ').trim();
    t = t.replace(/^["'“”‘’«»(\[{]+/, '').replace(/["'“”‘’«»)\]},;:]+$/, '').trim();
    if (t.length > 3 && /\p{Ll}\.$/u.test(t)) t = t.slice(0, -1);
    return t.trim();
}

const MONTH_OR_DAY_WORD_RE = /\b(januari|februari|maart|april|mei|juni|juli|augustus|september|oktober|november|december|jan|feb|mrt|apr|jun|jul|aug|sep|sept|okt|nov|dec|january|february|march|may|june|july|august|october|maandag|dinsdag|woensdag|donderdag|vrijdag|zaterdag|zondag|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i;

const STREET_WORD_RE = /(straat|laan|weg|plein|gracht|dijk|kade|singel|hof|pad|steeg|dreef|boulevard|drive|road|street|avenue|lane)\b/i;

// Returns a short reason when an LLM entity cannot be PII of the given type,
// or '' when it should be kept. `chunkText` lets the lowercase-name rule stand
// down on all-lowercase input (e.g. some dictation transcripts).
export function llmFalsePositiveReason(entity, type, chunkText = '') {
    const chunkIsCased = /\p{Lu}/u.test(chunkText);
    if (isObviousGarbage(entity, type, { requireCapitals: chunkIsCased })) return 'role, label or common word';
    const hasDigit = /\d/.test(entity);
    const hasUpper = /\p{Lu}/u.test(entity);
    switch (type) {
        case 'DATE':
            if (!hasDigit && !MONTH_OR_DAY_WORD_RE.test(entity)) return 'date without a number or month';
            break;
        case 'AGE':
            if (!hasDigit) return 'age without a number';
            break;
        case 'PHONE':
            if ((entity.match(/\d/g) || []).length < 6) return 'phone with fewer than 6 digits';
            break;
        case 'EMAIL':
            if (!entity.includes('@')) return 'email without @';
            break;
        case 'PERSON':
        case 'LOCATION':
        case 'ORGANIZATION':
            if (chunkIsCased && !hasUpper && !hasDigit && !entity.includes('@')) return 'lowercase common noun, not a proper name';
            break;
        case 'ADDRESS':
            if (!hasDigit && !hasUpper && !STREET_WORD_RE.test(entity)) return 'address without number, capital or street word';
            break;
        default:
            break;
    }
    return '';
}

// Normalise types, dedupe, and drop non-verbatim or non-PII output.
export function filterLLMEntities(rawEntities, chunkText) {
    const kept = [];
    const dropped = [];
    const seen = new Set();
    const haystack = normalizeForMatch(chunkText);
    for (const raw of rawEntities) {
        if (!raw || typeof raw.entity !== 'string') continue;
        const type = normalizeLLMType(raw.type);
        const entity = cleanLLMEntityText(raw.entity);
        if (entity.length < 2) continue;
        const key = createDetectionKey(entity, type);
        if (seen.has(key)) continue;
        seen.add(key);
        if (!haystack.includes(normalizeForMatch(entity))) {
            dropped.push({ entity, type, reason: 'not a verbatim quote of the text' });
            continue;
        }
        const reason = llmFalsePositiveReason(entity, type, chunkText);
        if (reason) {
            dropped.push({ entity, type, reason });
            continue;
        }
        kept.push({ entity, type });
    }
    return { kept, dropped };
}
