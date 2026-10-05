#!/usr/bin/env node

/**
 * test-roster-score.mjs — regression tests for contact ranking.
 *
 * Every case here is a REAL string from data/rosters/*.json that the previous
 * flat-score ranker got wrong, or a negative that must never regress. No network,
 * no browser, no LinkedIn budget — run it freely.
 *
 *   node scripts/test-roster-score.mjs
 */

import './fixtures/use-test-profile.mjs'; // first: pin targets.mjs to the fixture profile
import {
  employerEvidence, parseTitle, currentOnly, CORRUPTED,
  companyAliases, assignPersonas, ladderFor,
} from './roster-score.mjs';

let pass = 0, fail = 0;
const ok = (cond, label, got) => {
  if (cond) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; console.log(`  ❌ ${label}${got !== undefined ? `  (got: ${JSON.stringify(got)})` : ''}`); }
};
const eq = (got, want, label) => ok(got === want, label, got);

console.log('\n1. Employer evidence — positives');
const P = [
  ['Lead Software Engineer@Observe.AI and forward deployed', 'observeai'],  // no space after @
  ['Solutions Architect @ Retell AI', 'retellai'],
  ['Head of Forward Deployed Engineers & RL Env @ Labelbox/Alignerr', 'labelbox'], // dual employer
  ['Producer at Luma Labs', 'lumalabsai'],                                   // multi-word + suffix
  ['Engineering @ Soff (YC S24)', 'soff-ai'],
  ['Sr Technical Recruiter at Uber', 'uber'],
  ['Talent @ Stripe', 'stripe'],
];
for (const [h, slug] of P) eq(employerEvidence(h, companyAliases(slug)), 'ours', `[${slug}] ${h.slice(0, 52)}`);

console.log('\n2. Employer evidence — negatives that must never regress');
// 'other' = names a DIFFERENT employer -> hard drop. This is the leaky-currentCompany guard.
eq(employerEvidence('Data Engineer @ Metronome', companyAliases('labelbox')), 'other', 'competitor headline dropped');
eq(employerEvidence('Recruiter at Cisco', companyAliases('anthropicresearch')), 'other', 'the Cisco-as-Anthropic-Leader leak');
eq(employerEvidence('Lead Development Representative at TeleNet Marketing Solutions', companyAliases('uber')),
   'other', 'the TeleNet-as-Uber-contact leak');
eq(employerEvidence('Data Engineer at Exabeam', companyAliases('exa-ai')), 'other',
   'suffix stripping must not make exa-ai match Exabeam');
eq(employerEvidence('Stripe Alternatives Blog author', companyAliases('stripe')), 'none',
   'substring match must not count (old .includes() bug)');
// 'none' = names NO employer -> surfaced but never auto-picked (the Farida signature).
eq(employerEvidence('Technical Recruiter', companyAliases('labelbox')), 'none', 'bare title names no employer');
eq(employerEvidence('Accomplished Sales professional with over 20 years of experience', companyAliases('uber')),
   'none', 'prose headline names no employer');

console.log('\n3. Past-employer clauses never set the current level');
const MICHEL = 'Software Engineer AI/ML, OpenAI, ex: Meta Superintelligence Labs, Director of Engineering@Snap, VP Engineering@Upstart, Head of Mobile@Vine';
eq(parseTitle(currentOnly(MICHEL)).level, 0, 'colon form: "ex: ..." poisons to end of string (IC stays an IC)');
eq(employerEvidence(MICHEL, companyAliases('openai')), 'ours', 'and the current employer still resolves');
eq(parseTitle(currentOnly('ex-Google, now VP Engineering at Acme')).level, 4,
   'bare form: only the following token is dropped, real title survives');

console.log('\n4. Level and function are INDEPENDENT axes');
const ramy = parseTitle('Head of Forward Deployed Engineers & RL Env @ Labelbox/Alignerr', ['forward deployed']);
eq(ramy.level, 3, 'Labelbox HM parses as level 3 (was tagged as a peer and dropped from drafts)');
eq(ramy.fn, 'solutions', '...with function=solutions');
ok(ramy.teamMatch, '...and matches the team token via stemming ("Deployed" ~ "deployed")');
eq(parseTitle('Sales Director, Voice AI').fn, 'gtm', 'an AI-flavoured sales title is NOT engineering');
eq(parseTitle('Chief Revenue Officer').excluded, true, 'CxO excluded');
eq(parseTitle('CRO').excluded, true, 'CxO acronym excluded (old EXCLUDE_RE missed CRO/CPO/CIO)');

console.log('\n5. Corrupted cards');
ok(CORRUPTED({ name: 'Farida Helmy', title: 'Farida Helmy sent the following message at 1:' }),
   'message chrome captured as a title is flagged for repair');
ok(!CORRUPTED({ name: 'Ramy F.', title: 'Head of Forward Deployed Engineers' }), 'a real title is not corrupted');

console.log('\n6. Persona allocation scales with size');
eq(ladderFor(30).alloc.Leader, 0, '<60 employees: Leader collapses into the (excluded) founder');
eq(ladderFor(300).alloc['Hiring Manager'], 2, '200-800: HM gets the depth');
eq(ladderFor(300).alloc.Leader, 1, '...and Leader gets one (old code had this backwards: Leader 2 / HM 1)');
eq(ladderFor(5000).alloc.Leader, 0, '>=2000: Leader dropped, a VP 3 levels up will not read cold mail');

console.log('\n7. No top-up, and the authority gate holds');
const people = [
  { name: 'Real HM', title: 'Head of Forward Deployed Engineering @ Acme', profileUrl: 'u1' },
  { name: 'Stranger', title: 'Lead Development Representative at TeleNet Marketing Solutions', profileUrl: 'u2' },
  { name: 'Vague Boss', title: 'Engineering Leader', profileUrl: 'u3' },
];
const r = assignPersonas(people, {
  aliases: companyAliases('acme'), teamTokens: ['forward deployed'], jdKeywords: [],
  fnWanted: 'solutions', employeeCount: 300,
});
ok(r.selection.some(p => p.name === 'Real HM'), 'the real HM is selected');
ok(!r.selection.some(p => p.name === 'Stranger'), 'the other-employer stranger is never padded in');
ok(!r.selection.some(p => p.name === 'Vague Boss'), 'the employer-less authority is not auto-picked');
ok(r.unresolvedAuthority.some(p => p.name === 'Vague Boss'), '...but IS surfaced for manual verification');
ok(r.missingPersonas.length > 0, 'unfilled slots are reported, not filled with whoever is left');

console.log(`\n${'='.repeat(50)}\n📊 ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
