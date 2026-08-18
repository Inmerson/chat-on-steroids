/**
 * What a handoff brief has to contain, in one place.
 *
 * One caller, now. These rules used to be shared with an external writer — a second model
 * that was handed a packed recording of the session and asked for the same document — and
 * keeping the two prompts from drifting was the reason this file exists. That path is gone:
 * the brief is written by the ChatGPT conversation that *is* the recording, and the answer it
 * writes is the brief. What survives is the specification of the document itself, which is
 * worth having in one named place whatever ends up reading it.
 */

/** The rules and headings. */
export const HANDOFF_BRIEF_RULES = `Rules:
- The user's messages are the specification. Preserve the original task, every requirement, every later correction, and every constraint. If a later message changed an earlier requirement, state the final position and say that it changed.
- Never drop a requirement because it looks minor or because it was not worked on. Unfinished requirements matter most.
- Use the tool evidence to decide what is actually done. An assistant message saying it will do something is not evidence that it happened; a recorded tool call that succeeded is. Say plainly which is which.
- Keep exact identifiers: file paths, function names, versions, ports, hashes, ids, command lines, error text. Do not paraphrase them.
- Separate clearly: what is complete and verified · what was attempted and failed · what was only discussed · what is still to do.
- Include failures and unresolved bugs with the actual error, and say what was already tried so it is not repeated.
- AGENT MESSAGE lines are traffic with other agents in a multi-agent run. One delivered to this agent is a report about work done outside this recording — treat it as the only evidence of that work and keep its substance. One sent by this agent is work already delegated; say who is doing it so it is not delegated again.
- State the current state of the repository, install and running processes as far as the recording shows it.
- Be dense and operational. No preamble, no praise, no restating these instructions, no "in this session we". Bullet points and short lines.
- If the recording is incomplete or ambiguous, say so in one line rather than inventing detail.

Structure the brief with these headings, omitting any that would be empty:

TASK — the original goal, in the user's terms.
REQUIREMENTS — every constraint and requirement, including corrections.
DONE — completed and verified, with the evidence.
IN PROGRESS — started, not finished, and exactly where it stopped.
FAILED / UNRESOLVED — what broke, the error, what was already tried.
FILES — paths touched and what changed in each.
ENVIRONMENT — commands, versions, running processes, repo state.
NEXT — the concrete next actions, in order.
DO NOT — what the next agent should not redo or undo.`;

/**
 * The instruction typed into the ChatGPT conversation being compacted.
 *
 * The model is already the participant rather than a reader of a transcript, so there is no
 * recording to hand it and "the tool evidence" is its own call history.
 *
 * The brief leaves as the answer, deliberately. A tool call is a thing the model can retry,
 * skip, or make three different versions of, and every one of those was a way for a
 * compaction to end with the wrong brief or none. An answer cannot be retried: the page
 * watches this exact generation, and whatever it finally wrote is what gets carried across.
 * So there is nothing here to call, and nothing to get right except the writing.
 */
export function nativeHandoffPrompt(): string {
  return (
    'ChatGPT Local Files is compacting this conversation so a fresh chat can continue the work. ' +
    'Stop whatever you were doing and do only this.\n\n' +
    'Write a handoff brief so a different coding agent can continue this unfinished task in a brand-new ' +
    "conversation, with no memory of anything here. Everything you know about this session — the user's " +
    'messages, your own replies, and every tool call you made against this machine with its result — is the ' +
    'material. Write it so an agent who reads only your brief can carry on correctly.\n\n' +
    `${HANDOFF_BRIEF_RULES}\n\n` +
    'Your reply to this message must be the brief itself and nothing else: no preamble, no closing remark, no ' +
    'question back, and no tool calls. The app reads this reply, stores it, and opens the fresh chat with it.'
  );
}
