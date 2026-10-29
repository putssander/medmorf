// Import the shipped module graph without rewriting imports or inventing missing HTML IDs.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
class Element {
    value = ''; checked = false; disabled = true; children = []; listeners = {}; textContent = '';
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    addEventListener(name, listener) { this.listeners[name] = listener; }
    querySelector(selector) { return selector === 'input' ? this.children.at(-1) : null; }
    setAttribute() {}
}
const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const nodes = new Map([...html.matchAll(/\bid="([^"]+)"/g)].map(match => [match[1], new Element()]));
globalThis.document = { getElementById: id => nodes.get(id) || null, createElement: () => new Element() };
globalThis.window = {};
await import('../src/data-prompt-handler.js');
const input = nodes.get('dpFiles'), status = nodes.get('dpStatus');
assert.equal(input.disabled, false);
assert.match(status.textContent, /Ready to read local files/);
const fixture = await readFile(new URL('./fixtures/data-prompt-folder/records.json', import.meta.url), 'utf8');
const select = async () => {
    const target = { value: 'records.json', files: [{ name: 'records.json', size: fixture.length, text: async () => fixture }] };
    await input.onchange({ target });
    assert.equal(target.value, '');
    assert.match(status.textContent, /1 files \/ 1 tables prepared/);
    assert.equal(nodes.get('dpExplore').hidden, false);
};
await select();
await select();
const prompt = nodes.get('dpPrompt').value;
input.listeners.cancel();
assert.match(status.textContent, /cancelled/);
assert.equal(nodes.get('dpPrompt').value, prompt);
await input.onchange({ target: { files: [], value: '' } });
assert.equal(nodes.get('dpPrompt').value, prompt);
assert.match(status.textContent, /No files selected/);
await input.onchange({ target: { files: [{ name: 'broken.json', size: 2, text: async () => '{' }], value: '' } });
assert.match(status.textContent, /No supported tables could be read/);
assert.equal(input.disabled, false);
console.log('Unmodified startup imports, real HTML IDs, readiness, reselection, cancellation and file error feedback passed.');
