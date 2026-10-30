import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type {
  AgentMessage,
  AgentRun,
  AgentStep,
  ChatAttachment,
  ChatMessage,
  Cue,
  Project,
  Section,
  Speaker,
  TimedBeat,
  WriterAnswer,
  WriterQuestion,
} from "../types";
import * as api from "../lib/api";
import { errorMessage } from "../lib/api";
import {
  agentTools,
  agentWindow,
  buildAgentRequest,
  buildContinueKickoff,
  buildContinueSystemPrompt,
  createAliases,
  describeRun,
  parseContinueCommand,
  runAgent,
  type AgentDeps,
  type AgentEnv,
  type DescribeFrame,
} from "../lib/agent";
import {
  buildStoryKickoff,
  buildStorySystemPrompt,
  createStoryAliases,
  describeStoryRun,
  parseStoryCommand,
  runStory,
  storyTools,
  type StoryEnv,
  type StoryState,
} from "../lib/storyAgent";
import {
  CHAT_EFFORTS,
  MAX_CHAT_LINES,
  MIN_CHAT_LINES,
  anchorFor,
  attachmentLabel,
  buildAttachment,
  buildChatRequest,
  buildChatSystemPrompt,
  buildSelection,
  chatEffort,
  historyTurns,
  rewriteMessage,
  shortModelName,
} from "../lib/chat";
import { makeId } from "../lib/ids";
import { parseMarkdown, type Inline } from "../lib/markdown";
import { formatShort } from "../lib/time";

interface Props {
  cues: Cue[];
  speakers: Speaker[];
  sections: Section[];
  brief: string;
  beats: string[];
  primaryId: string | null;
  /** Sent along with every message. */
  selectedIds: ReadonlySet<string>;
  currentTime: number;
  /** Seconds; 0 while no video is loaded. */
  duration: number;
  /** The limits `/continue` writes within, from Settings. */
  reading: Pick<AgentEnv, "targetCps" | "minGap" | "maxCharsPerLine" | "maxLines">;
  /** The video `/continue` may look at; "" when none is loaded. */
  videoPath: string;
  /** Describes frames for `/continue`; "" leaves it without eyes. */
  visionModel: string;
  /** The models the select offers, from Settings. */
  models: string[];
  /** The one in use: already resolved against `models`, "" when there are none. */
  model: string;
  /** As stored; an unknown value means the model's default. */
  effort: string;
  temperature: number;
  /** How many lines "Last N" attaches. */
  linesBefore: number;
  apiKeySet: boolean;
  /** Changes when another project opens, which starts a fresh conversation. */
  projectKey: string;
  height: number;
  onLinesChange: (lines: number) => void;
  onModelChange: (model: string) => void;
  onEffortChange: (effort: string) => void;
  onOpenSettings: () => void;
  /** Story beats with a time; `/story` writes them, `/continue` heads for them. */
  timedBeats: TimedBeat[];
  /** Text to put in the chat box, e.g. `/story ` from the Sections panel. */
  prefill: { text: string; nonce: number } | null;
  /** A run changed the project; every call with one `runId` is one undo step. */
  onAgentPatch: (patch: Partial<Pick<Project, "cues" | "sections" | "beats" | "timedBeats">>, runId: string) => void;
  /** A run finished, with the cues it added that still exist. */
  onAgentDone: (created: string[]) => void;
}

/** Within this many pixels of the bottom, the log follows a streaming reply. */
const STICK_THRESHOLD = 24;

export function ChatPanel({
  cues,
  speakers,
  sections,
  brief,
  beats,
  primaryId,
  selectedIds,
  currentTime,
  duration,
  reading,
  videoPath,
  visionModel,
  models,
  model,
  effort,
  temperature,
  linesBefore,
  apiKeySet,
  projectKey,
  height,
  onLinesChange,
  onModelChange,
  onEffortChange,
  onOpenSettings,
  timedBeats,
  prefill,
  onAgentPatch,
  onAgentDone,
}: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [attachment, setAttachment] = useState<ChatAttachment | null>(null);
  const [draftOpen, setDraftOpen] = useState(false);
  const [selectionOpen, setSelectionOpen] = useState(false);
  const [openAttachments, setOpenAttachments] = useState<Set<string>>(new Set());
  const [streaming, setStreaming] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  /** A `/continue` run's question, waiting on the writer in place of the composer. */
  const [asking, setAsking] = useState<WriterQuestion | null>(null);
  const pendingAnswer = useRef<{
    resolve: (answer: WriterAnswer) => void;
    reject: (reason: unknown) => void;
  } | null>(null);
  /** The user message being rewritten in place, with its edits so far. */
  const [editing, setEditing] = useState<{
    id: string;
    text: string;
    attachment: ChatAttachment | null;
  } | null>(null);

  // Bumped by Reset and project switches, so a reply still arriving for the
  // old conversation cannot write into the new one.
  const generation = useRef(0);
  const streamingRef = useRef(false);
  streamingRef.current = streaming;

  // What a run works on: its own edits at once, and the writer's (or an undo)
  // as soon as they reach the props. Each field is refreshed on its own, so a
  // run's edit to one is not overwritten by a stale render of another.
  const props = { cues, sections, beats, timedBeats };
  const latest = useRef({ ...props });
  const seen = useRef({ ...props });
  for (const key of Object.keys(props) as Array<keyof typeof props>) {
    if (props[key] !== seen.current[key]) {
      (seen.current as Record<string, unknown>)[key] = props[key];
      (latest.current as Record<string, unknown>)[key] = props[key];
    }
  }

  const logRef = useRef<HTMLDivElement | null>(null);
  const stick = useRef(true);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  const selection = useMemo(
    () => buildSelection(cues, sections, speakers, selectedIds),
    [cues, sections, speakers, selectedIds],
  );

  /** Answers the open question, or with null withdraws it, which stops the run. */
  const answerQuestion = useCallback((answer: WriterAnswer | null) => {
    const pending = pendingAnswer.current;
    pendingAnswer.current = null;
    setAsking(null);
    if (!pending) return;
    if (answer) pending.resolve(answer);
    else pending.reject(api.CHAT_CANCELLED);
  }, []);

  const reset = useCallback(() => {
    generation.current++;
    answerQuestion(null);
    if (streamingRef.current) api.cancelChat().catch(() => {});
    setMessages([]);
    setAttachment(null);
    setDraftOpen(false);
    setSelectionOpen(false);
    setOpenAttachments(new Set());
    setStreaming(false);
    setNotice(null);
    setEditing(null);
    stick.current = true;
  }, [answerQuestion]);

  useEffect(() => reset, [projectKey, reset]);

  // ✦ Story in the Sections panel: the command, ready for a direction.
  useEffect(() => {
    if (!prefill) return;
    setDraft(prefill.text);
    const input = inputRef.current;
    if (input) {
      input.focus();
      input.setSelectionRange(prefill.text.length, prefill.text.length);
    }
  }, [prefill]);

  useLayoutEffect(() => {
    const log = logRef.current;
    if (log && stick.current) log.scrollTop = log.scrollHeight;
  }, [messages]);

  const attachLines = () => {
    const anchor = anchorFor(cues, primaryId, currentTime);
    const next = buildAttachment(cues, sections, speakers, anchor, linesBefore);
    if (!next) {
      setNotice("No lines there yet — select a cue or move the playhead past one.");
      return;
    }
    setNotice(null);
    setAttachment(next);
    setDraftOpen(false);
    inputRef.current?.focus();
  };

  const stop = () => {
    answerQuestion(null);
    api.cancelChat().catch(() => {});
  };

  /** Asks `question` after `earlier`, streaming the reply into the log. */
  const ask = async (earlier: ChatMessage[], question: ChatMessage) => {
    const reply: ChatMessage = { id: makeId(), role: "assistant", text: "", status: "streaming" };
    const history = [...earlier, question];

    const system = buildChatSystemPrompt({
      brief,
      beats,
      speakers,
      sections,
      anchor: anchorFor(cues, primaryId, currentTime),
      timedBeats,
    });
    const request = buildChatRequest(system, history, {
      model,
      temperature,
      effort: chatEffort(effort),
    });

    // An edit can land while a reply streams. The new request aborts that one
    // in the backend; the bump makes its last words and its "cancelled" land
    // nowhere. No cancelChat here: it could arrive after, and stop, the new one.
    const mine = ++generation.current;
    setMessages([...history, reply]);
    setStreaming(true);
    stick.current = true;

    const update = (patch: (m: ChatMessage) => ChatMessage) => {
      if (generation.current !== mine) return;
      setMessages((all) => all.map((m) => (m.id === reply.id ? patch(m) : m)));
    };

    try {
      await api.aiChat(request, (text) => update((m) => ({ ...m, text: m.text + text })));
      update(({ status: _, ...m }) => m);
    } catch (e) {
      const message = errorMessage(e);
      if (message === api.CHAT_CANCELLED) {
        update((m) => ({ ...m, status: "stopped" }));
      } else {
        update((m) => ({ ...m, status: "error", text: m.text ? `${m.text}\n\n${message}` : message }));
      }
    } finally {
      if (generation.current === mine) setStreaming(false);
    }
  };

  const vision = visionModel.trim() !== "" && videoPath !== "";

  /**
   * A tool-using run — `/continue` or `/story` — in the log: its bubble lists
   * each step as it lands, the question card answers it, Stop and Reset end it,
   * and the conversation remembers it as one line.
   */
  const runInChat = async <R extends { ending: "finished" | "limit" | "abandoned"; summary: string }>(
    earlier: ChatMessage[],
    question: ChatMessage,
    setup: {
      run: AgentRun;
      describe: (run: AgentRun) => string;
      tools: unknown[];
      go: (deps: Pick<AgentDeps, "send" | "onStep" | "isCurrent" | "describeFrame" | "askWriter">) => Promise<R>;
      onDone?: (result: R) => void;
    },
  ) => {
    const { run } = setup;
    const reply: ChatMessage = { id: makeId(), role: "assistant", text: "", status: "streaming", agent: run };
    const settings = { model, temperature, effort: chatEffort(effort) };
    /** A failed or refused look is an answer; only a Stop ends the run. */
    const describeFrame: DescribeFrame = async (time, question) => {
      try {
        const description = await api.aiDescribeFrame({ videoPath, time, model: visionModel, question });
        return { ok: true, description };
      } catch (e) {
        const message = errorMessage(e);
        if (message === api.CHAT_CANCELLED) throw e;
        return { ok: false, error: message };
      }
    };

    const mine = ++generation.current;
    setMessages([...earlier, question, reply]);
    setStreaming(true);
    stick.current = true;

    const update = (patch: (m: ChatMessage) => ChatMessage) => {
      if (generation.current !== mine) return;
      setMessages((all) => all.map((m) => (m.id === reply.id ? patch(m) : m)));
    };
    let steps: AgentStep[] = [];
    /** The run as it ends, remembered by the conversation as one line. */
    const end = (summary: string | undefined, status?: ChatMessage["status"]) => {
      const done: AgentRun = { ...run, steps, ...(summary ? { summary } : {}) };
      update(({ status: _, ...m }) => ({ ...m, agent: done, text: setup.describe(done), ...(status ? { status } : {}) }));
    };

    try {
      const result = await setup.go({
        send: (conversation) => api.aiAgentStep(buildAgentRequest(conversation, settings, setup.tools)),
        ...(vision ? { describeFrame } : {}),
        askWriter: (question) =>
          new Promise<WriterAnswer>((resolve, reject) => {
            pendingAnswer.current = { resolve, reject };
            setAsking(question);
          }),
        onStep: (step) => {
          steps = [...steps, step];
          update((m) => ({ ...m, agent: { ...run, steps } }));
        },
        isCurrent: () => generation.current === mine,
      });
      if (result.ending === "abandoned") return;
      end(result.summary, result.ending === "limit" ? "stopped" : undefined);
      setup.onDone?.(result);
    } catch (e) {
      const message = errorMessage(e);
      if (message === api.CHAT_CANCELLED) {
        end(undefined, "stopped");
      } else {
        update((m) => ({ ...m, agent: { ...run, steps }, status: "error", text: message }));
      }
    } finally {
      if (generation.current === mine) setStreaming(false);
    }
  };

  /**
   * `/continue`: hands the model the window from the playhead and lets it
   * write there with tools until it is done, its edits landing as it goes.
   */
  const runContinue = (
    earlier: ChatMessage[],
    question: ChatMessage,
    command: { seconds: number; direction: string },
  ) => {
    const stretch = agentWindow(currentTime, command.seconds, duration);
    if (stretch.end - stretch.start < 1) {
      setNotice("The playhead is at the end of the video — move it back to continue from there.");
      return;
    }
    const env: AgentEnv = { window: stretch, duration, vision, speakers, sections, ...reading };
    const aliases = createAliases();
    const runId = makeId();
    const opening: AgentMessage[] = [
      { role: "system", content: buildContinueSystemPrompt({ brief, beats }, env) },
      ...historyTurns(earlier),
      {
        role: "user",
        content: buildContinueKickoff(
          latest.current.cues,
          env,
          aliases,
          command.direction,
          linesBefore,
          latest.current.timedBeats,
        ),
      },
    ];

    void runInChat(earlier, question, {
      run: { from: stretch.start, to: stretch.end, steps: [] },
      describe: describeRun,
      tools: agentTools(vision),
      go: (deps) =>
        runAgent(opening, env, aliases, {
          ...deps,
          getCues: () => latest.current.cues,
          applyCues: (next) => {
            latest.current.cues = next;
            onAgentPatch({ cues: next }, runId);
          },
        }),
      onDone: (result) => onAgentDone(result.created.filter((id) => latest.current.cues.some((c) => c.id === id))),
    });
  };

  /**
   * `/story`: lets the model work on the outline — section notes, timed beats,
   * the overall beats — asking and looking as it needs, its edits landing live.
   */
  const runStoryInChat = (earlier: ChatMessage[], question: ChatMessage, command: { direction: string }) => {
    const env: StoryEnv = { duration, vision, speakers };
    const aliases = createStoryAliases();
    const runId = makeId();
    const state = (): StoryState => ({
      sections: latest.current.sections,
      beats: latest.current.beats,
      timedBeats: latest.current.timedBeats,
    });
    const opening: AgentMessage[] = [
      { role: "system", content: buildStorySystemPrompt({ brief, beats: latest.current.beats }, env) },
      ...historyTurns(earlier),
      { role: "user", content: buildStoryKickoff(state(), latest.current.cues, env, aliases, command.direction) },
    ];

    void runInChat(earlier, question, {
      run: { kind: "story", from: 0, to: duration, steps: [] },
      describe: describeStoryRun,
      tools: storyTools(vision),
      go: (deps) =>
        runStory(opening, env, aliases, {
          ...deps,
          getState: state,
          getCues: () => latest.current.cues,
          applyState: (next) => {
            Object.assign(latest.current, next);
            onAgentPatch({ sections: next.sections, beats: next.beats, timedBeats: next.timedBeats }, runId);
          },
        }),
    });
  };

  /** Asks `question`, or runs it when it is a `/story` or a `/continue`. */
  const dispatch = (earlier: ChatMessage[], question: ChatMessage) => {
    // An edit sent while a run waits on an answer replaces that run.
    answerQuestion(null);
    const story = parseStoryCommand(question.text);
    const command = parseContinueCommand(question.text);
    if (story) runStoryInChat(earlier, question, story);
    else if (command) runContinue(earlier, question, command);
    else void ask(earlier, question);
  };

  const ready = apiKeySet && model !== "";

  const send = () => {
    if (streaming || !ready) return;
    if (!draft.trim() && !attachment) return;

    setDraft("");
    setNotice(null);
    if (parseContinueCommand(draft) || parseStoryCommand(draft)) {
      // The run reads the script itself; an attachment waits for a question.
      dispatch(messages, { id: makeId(), role: "user", text: draft.trim() });
      return;
    }

    const question: ChatMessage = {
      id: makeId(),
      role: "user",
      text: draft.trim(),
      ...(attachment ? { attachment } : {}),
      ...(selection ? { selection } : {}),
    };
    setAttachment(null);
    setDraftOpen(false);
    dispatch(messages, question);
  };

  const startEditing = (message: ChatMessage) =>
    setEditing({ id: message.id, text: message.text, attachment: message.attachment ?? null });

  const selectionKey = (id: string) => `${id}:selection`;

  const saveEdit = () => {
    if (!editing || !ready) return;
    const rewritten = rewriteMessage(messages, editing.id, editing, makeId());
    if (!rewritten) return;
    setEditing(null);
    dispatch(rewritten.earlier, rewritten.question);
  };

  const toggleAttachment = (id: string) =>
    setOpenAttachments((open) => {
      const next = new Set(open);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const canSend = ready && !streaming && (draft.trim() !== "" || attachment !== null);

  return (
    <section className="panel chat-panel" style={{ height }}>
      <header className="panel-header">
        <h2>Chat</h2>
        <button
          type="button"
          className="small"
          onClick={reset}
          disabled={messages.length === 0 && !attachment && !draft}
          title="Clear the conversation and start over"
        >
          Reset
        </button>
      </header>

      <div
        className="chat-log"
        ref={logRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_THRESHOLD;
        }}
      >
        {messages.length === 0 && (
          <p className="hint">
            Talk through ideas with a model that knows the brief, beats, speakers and
            current section. Selected cues go along with every message.{" "}
            <strong>📎 Last {linesBefore}</strong> hands it the lines up to the selected
            cue, or the playhead. <strong>/continue 30</strong> lets it write the next 30
            seconds from the playhead itself, with your direction after the number.
            <strong>/story</strong> works on the outline: section notes and timed beats.
          </p>
        )}

        {messages.map((message) =>
          editing?.id === message.id ? (
            <MessageEditor
              key={message.id}
              text={editing.text}
              attachment={editing.attachment}
              attachmentOpen={openAttachments.has(message.id)}
              selection={message.selection ?? null}
              selectionOpen={openAttachments.has(selectionKey(message.id))}
              discards={messages.length - messages.indexOf(message) - 1}
              canSend={ready && (editing.text.trim() !== "" || editing.attachment !== null)}
              onText={(text) => setEditing({ ...editing, text })}
              onToggleAttachment={() => toggleAttachment(message.id)}
              onToggleSelection={() => toggleAttachment(selectionKey(message.id))}
              onRemoveAttachment={() => setEditing({ ...editing, attachment: null })}
              onSave={saveEdit}
              onCancel={() => setEditing(null)}
            />
          ) : (
            <div key={message.id} className={`chat-msg ${message.role} ${message.status ?? ""}`}>
              {message.attachment && (
                <AttachmentChip
                  attachment={message.attachment}
                  open={openAttachments.has(message.id)}
                  onToggle={() => toggleAttachment(message.id)}
                />
              )}
              {message.selection && (
                <AttachmentChip
                  attachment={message.selection}
                  kind="selection"
                  open={openAttachments.has(selectionKey(message.id))}
                  onToggle={() => toggleAttachment(selectionKey(message.id))}
                />
              )}
              {message.role === "user" ? (
                <>
                  {message.text && <div className="chat-text">{message.text}</div>}
                  <button
                    type="button"
                    className="chat-edit"
                    onClick={() => startEditing(message)}
                    title="Rewrite this message and ask again from here"
                  >
                    ✎ Edit
                  </button>
                </>
              ) : message.agent ? (
                <AgentLog
                  run={message.agent}
                  status={message.status}
                  error={message.text}
                  waiting={asking !== null && message.status === "streaming"}
                />
              ) : message.status === "error" ? (
                <div className="chat-text error">{message.text}</div>
              ) : (
                <div className="chat-text markdown">
                  <Markdown source={message.text} />
                  {message.status === "streaming" && !message.text && (
                    <span className="chat-thinking">thinking…</span>
                  )}
                  {message.status === "streaming" && <span className="chat-caret" />}
                  {message.status === "stopped" && <span className="chat-stopped">stopped</span>}
                </div>
              )}
            </div>
          ),
        )}
      </div>

      {asking ? (
        <QuestionCard key={asking.question} question={asking} onAnswer={answerQuestion} onStop={stop} />
      ) : (
        <div className="chat-composer">
          {!apiKeySet && (
            <div className="chat-banner">
              <span>No OpenRouter API key saved yet.</span>
              <button type="button" className="small" onClick={onOpenSettings}>
                Open Settings
              </button>
            </div>
          )}

          {apiKeySet && models.length === 0 && (
            <div className="chat-banner">
              <span>No chat models yet.</span>
              <button type="button" className="small" onClick={onOpenSettings}>
                Open Settings
              </button>
            </div>
          )}

          {notice && <p className="hint">{notice}</p>}

          {attachment && (
            <AttachmentChip
              attachment={attachment}
              open={draftOpen}
              onToggle={() => setDraftOpen((o) => !o)}
              onRemove={() => {
                setAttachment(null);
                setDraftOpen(false);
              }}
            />
          )}

          {selection && (
            <AttachmentChip
              attachment={selection}
              kind="selection"
              open={selectionOpen}
              onToggle={() => setSelectionOpen((o) => !o)}
            />
          )}

          <textarea
            ref={inputRef}
            rows={2}
            placeholder="Ask about a scene… or /continue 30 to write, /story to plan the outline"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              // Typing here must never fire an editor shortcut.
              e.stopPropagation();
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send();
              } else if (e.key === "Escape") {
                if (streaming) stop();
                else e.currentTarget.blur();
              }
            }}
          />

          {models.length > 0 && (
            <div className="chat-options">
              <select
                value={model}
                aria-label="Chat model"
                title={model}
                onKeyDown={(e) => e.stopPropagation()}
                onChange={(e) => onModelChange(e.target.value)}
              >
                {models.map((id) => (
                  <option key={id} value={id} title={id}>
                    {shortModelName(id)}
                  </option>
                ))}
              </select>
              <select
                value={chatEffort(effort) ?? ""}
                aria-label="Reasoning effort"
                title="How hard a reasoning model thinks before it answers. Default leaves it to the model."
                onKeyDown={(e) => e.stopPropagation()}
                onChange={(e) => onEffortChange(e.target.value)}
              >
                {CHAT_EFFORTS.map((e) => (
                  <option key={e.value} value={e.value}>
                    Effort: {e.label}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div className="chat-actions">
            <div className="chat-attach">
              <button
                type="button"
                className="small"
                onClick={attachLines}
                disabled={cues.length === 0}
                title="Attach the lines up to the selected cue, or the playhead"
              >
                📎 Last
              </button>
              <input
                type="number"
                min={MIN_CHAT_LINES}
                max={MAX_CHAT_LINES}
                value={linesBefore}
                aria-label="Lines to attach"
                onKeyDown={(e) => e.stopPropagation()}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  if (Number.isFinite(n) && n >= MIN_CHAT_LINES) {
                    onLinesChange(Math.min(MAX_CHAT_LINES, Math.round(n)));
                  }
                }}
              />
              <span className="hint">lines</span>
            </div>

            {streaming ? (
              <button type="button" className="small danger" onClick={stop} title="Stop the reply (Esc)">
                Stop
              </button>
            ) : (
              <button
                type="button"
                className="small primary"
                onClick={() => void send()}
                disabled={!canSend}
                title="Send (Enter). Shift+Enter for a new line."
              >
                Send
              </button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

interface EditorProps {
  text: string;
  attachment: ChatAttachment | null;
  attachmentOpen: boolean;
  /** As first sent; an edit keeps it. */
  selection: ChatAttachment | null;
  selectionOpen: boolean;
  /** Messages after this one that sending the edit throws away. */
  discards: number;
  canSend: boolean;
  onText: (text: string) => void;
  onToggleAttachment: () => void;
  onToggleSelection: () => void;
  onRemoveAttachment: () => void;
  onSave: () => void;
  onCancel: () => void;
}

/** A user message rewritten in place. Sending restarts the chat from it. */
function MessageEditor({
  text,
  attachment,
  attachmentOpen,
  selection,
  selectionOpen,
  discards,
  canSend,
  onText,
  onToggleAttachment,
  onToggleSelection,
  onRemoveAttachment,
  onSave,
  onCancel,
}: EditorProps) {
  const ref = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
    // Opening the editor only: later renders must not move the caret.
  }, []);

  return (
    <div className="chat-msg user editing">
      {attachment && (
        <AttachmentChip
          attachment={attachment}
          open={attachmentOpen}
          onToggle={onToggleAttachment}
          onRemove={onRemoveAttachment}
        />
      )}
      {selection && (
        <AttachmentChip
          attachment={selection}
          kind="selection"
          open={selectionOpen}
          onToggle={onToggleSelection}
        />
      )}
      <textarea
        ref={ref}
        rows={3}
        value={text}
        onChange={(e) => onText(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            if (canSend) onSave();
          } else if (e.key === "Escape") {
            onCancel();
          }
        }}
      />
      <div className="chat-edit-actions">
        {discards > 0 && (
          <span className="hint">
            Replaces the {discards} {discards === 1 ? "message" : "messages"} below
          </span>
        )}
        <button type="button" className="small" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="small primary" onClick={onSave} disabled={!canSend}>
          Send
        </button>
      </div>
    </div>
  );
}

interface ChipProps {
  attachment: ChatAttachment;
  /** An attachment can be removed; the selection goes with every message. */
  kind?: "attachment" | "selection";
  open: boolean;
  onToggle: () => void;
  onRemove?: () => void;
}

function AttachmentChip({ attachment, kind = "attachment", open, onToggle, onRemove }: ChipProps) {
  const noun = kind === "selection" ? "selected" : "attached";
  return (
    <div className="chat-attachment">
      <div className="chat-chip">
        <button
          type="button"
          className="chat-chip-label"
          aria-expanded={open}
          onClick={onToggle}
          title={open ? `Hide the ${noun} lines` : `Show the ${noun} lines`}
        >
          {kind === "selection" ? "Selected:" : "📎"} {attachmentLabel(attachment)}
        </button>
        {onRemove && (
          <button type="button" className="icon-button" title="Remove" onClick={onRemove}>
            ✕
          </button>
        )}
      </div>
      {open && <pre className="chat-transcript">{attachment.transcript}</pre>}
    </div>
  );
}

/** A `/continue` run: what it was allowed to change, and what it did there. */
function AgentLog({
  run,
  status,
  error,
  waiting,
}: {
  run: AgentRun;
  status: ChatMessage["status"];
  /** The message text, shown when the run failed. */
  error: string;
  /** The run has asked the writer something and waits for the answer. */
  waiting: boolean;
}) {
  const stretch = `${formatShort(run.from)}–${formatShort(run.to)}`;
  return (
    <div className="chat-text agent-log">
      <div className="agent-head">
        {run.kind === "story"
          ? status === "streaming"
            ? "Working on the outline"
            : "Outline"
          : `${status === "streaming" ? "Continuing" : "Continued"} ${stretch}`}
      </div>
      {run.steps.length > 0 && (
        <ul className="agent-steps">
          {run.steps.map((step, i) => (
            <li key={i} className={`agent-step ${step.kind}`}>
              {step.detail ? (
                <details>
                  <summary>{step.label}</summary>
                  <p className="agent-detail">{step.detail}</p>
                </details>
              ) : (
                step.label
              )}
            </li>
          ))}
        </ul>
      )}
      {status === "streaming" && (
        <span className="chat-thinking">{waiting ? "waiting for your answer below…" : "working…"}</span>
      )}
      {status === "error" && <div className="chat-text error">{error}</div>}
      {run.summary && <p className="agent-summary">{run.summary}</p>}
      {status === "stopped" && <span className="chat-stopped">stopped</span>}
    </div>
  );
}

/**
 * A run's question about direction, in place of the composer until answered:
 * pick an option (or press its number), say it in your own words, or skip.
 */
function QuestionCard({
  question,
  onAnswer,
  onStop,
}: {
  question: WriterQuestion;
  onAnswer: (answer: WriterAnswer) => void;
  onStop: () => void;
}) {
  const [own, setOwn] = useState("");
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    ref.current?.focus();
  }, []);

  const pick = (label: string) => onAnswer({ kind: "option", label });

  return (
    <div
      ref={ref}
      className="chat-composer question-card"
      role="group"
      aria-label="A question from the run"
      tabIndex={-1}
      onKeyDown={(e) => {
        // Answering here must never fire an editor shortcut.
        e.stopPropagation();
        if (e.key === "Escape") {
          e.preventDefault();
          onAnswer({ kind: "skipped" });
          return;
        }
        if (e.target instanceof HTMLInputElement) return;
        const n = Number(e.key);
        if (Number.isInteger(n) && n >= 1 && n <= question.options.length) {
          e.preventDefault();
          pick(question.options[n - 1].label);
        }
      }}
    >
      <p className="question-text">{question.question}</p>
      <div className="question-options">
        {question.options.map((option, i) => (
          <button key={option.label} type="button" className="question-option" onClick={() => pick(option.label)}>
            <span className="question-key">{i + 1}</span>
            <span className="question-body">
              <strong>{option.label}</strong>
              {option.description && <span className="question-description">{option.description}</span>}
            </span>
          </button>
        ))}
      </div>
      <form
        className="question-other"
        onSubmit={(e) => {
          e.preventDefault();
          if (own.trim()) onAnswer({ kind: "own", text: own.trim() });
        }}
      >
        <input
          value={own}
          placeholder="Or say it in your own words…"
          aria-label="Your own answer"
          onChange={(e) => setOwn(e.target.value)}
        />
        <button type="submit" className="small" disabled={!own.trim()}>
          Answer
        </button>
      </form>
      <div className="chat-actions">
        <button
          type="button"
          className="small"
          onClick={() => onAnswer({ kind: "skipped" })}
          title="Let the model decide (Esc)"
        >
          Skip — you decide
        </button>
        <button type="button" className="small danger" onClick={onStop} title="Stop the run">
          Stop
        </button>
      </div>
    </div>
  );
}

function Markdown({ source }: { source: string }) {
  return (
    <>
      {parseMarkdown(source).map((block, i) => {
        switch (block.kind) {
          case "heading": {
            const Tag = `h${block.level + 2}` as "h3" | "h4" | "h5";
            return <Tag key={i}>{renderInline(block.content)}</Tag>;
          }
          case "code":
            return <pre key={i}>{block.text}</pre>;
          case "list": {
            const Tag = block.ordered ? "ol" : "ul";
            return (
              <Tag key={i}>
                {block.items.map((item, j) => (
                  <li key={j}>{renderInline(item)}</li>
                ))}
              </Tag>
            );
          }
          case "paragraph":
            return (
              <p key={i}>
                {block.lines.map((line, j) => (
                  <Fragment key={j}>
                    {j > 0 && <br />}
                    {renderInline(line)}
                  </Fragment>
                ))}
              </p>
            );
        }
      })}
    </>
  );
}

function renderInline(nodes: Inline[]): ReactNode {
  return nodes.map((node, i) => {
    switch (node.kind) {
      case "text":
        return <Fragment key={i}>{node.text}</Fragment>;
      case "code":
        return <code key={i}>{node.text}</code>;
      case "strong":
        return <strong key={i}>{renderInline(node.children)}</strong>;
      case "em":
        return <em key={i}>{renderInline(node.children)}</em>;
    }
  });
}
