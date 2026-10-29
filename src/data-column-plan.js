// Plans contain aliases and bounded explanations, never source values.
export function planIssues(draft, columns) {
    if (!Array.isArray(draft?.groups) || !draft.groups.length) return ['Missing analysis groups'];
    const allowed = new Set(columns.map(c => c.alias)), seen = new Set(), issues = [];
    for (const group of draft.groups) {
        if (!Array.isArray(group?.columns) || !group.columns.length || group.columns.length > 4) { issues.push('Each group needs 1–4 columns'); continue; }
        if (typeof group.reason !== 'string' || !group.reason.trim() || group.reason.length > 240) issues.push('Each group needs a short reason');
        for (const alias of group.columns) {
            if (!allowed.has(alias)) issues.push('Unknown column alias');
            if (seen.has(alias)) issues.push('Column assigned more than once');
            seen.add(alias);
        }
    }
    for (const alias of allowed) if (!seen.has(alias)) issues.push(`${alias}: no analysis group`);
    return issues;
}
export function planColumnTasks(table, draft) {
    const issues = planIssues(draft, table.columns);
    if (issues.length) throw new Error(issues.join('; '));
    return draft.groups.map(group => ({
        columns: group.columns.map(alias => table.columns.find(c => c.alias === alias)),
        reason: group.reason.trim(), mode: group.columns.length > 1 ? 'combined' : 'individual',
    }));
}
