import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { ChatAttachment, ChatMessage, Cue, Section, Speaker } from "../types";
import * as api from "../lib/api";
import { errorMessage } from "../lib/api";
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
  rewriteMessage,
  shortModelName,
} from "../lib/chat";
import { makeId } from "../lib/ids";
import { parseMarkdown, type Inline } from "../lib/markdown";

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
}: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [attachment, setAttachment] = useState<ChatAttachment | null>(null);
  const [draftOpen, setDraftOpen] = useState(false);
  const [selectionOpen, setSelectionOpen] = useState(false);
  const [openAttachments, setOpenAttachments] = useState<Set<string>>(new Set());
  const [streaming, setStreaming] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
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

  const logRef = useRef<HTMLDivElement | null>(null);
  const stick = useRef(true);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  const selection = useMemo(
    () => buildSelection(cues, sections, speakers, selectedIds),
    [cues, sections, speakers, selectedIds],
  );

  const reset = useCallback(() => {
    generation.current++;
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
  }, []);

  useEffect(() => reset, [projectKey, reset]);

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

  const ready = apiKeySet && model !== "";

  const send = () => {
    if (streaming || !ready) return;
    if (!draft.trim() && !attachment) return;

    const question: ChatMessage = {
      id: makeId(),
      role: "user",
      text: draft.trim(),
      ...(attachment ? { attachment } : {}),
      ...(selection ? { selection } : {}),
    };
    setDraft("");
    setAttachment(null);
    setDraftOpen(false);
    setNotice(null);
    void ask(messages, question);
  };

  const startEditing = (message: ChatMessage) =>
    setEditing({ id: message.id, text: message.text, attachment: message.attachment ?? null });

  const selectionKey = (id: string) => `${id}:selection`;

  const saveEdit = () => {
    if (!editing || !ready) return;
    const rewritten = rewriteMessage(messages, editing.id, editing, makeId());
    if (!rewritten) return;
    setEditing(null);
    void ask(rewritten.earlier, rewritten.question);
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
            cue, or the playhead.
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
          placeholder="Ask about a scene, a character, what could happen next…"
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
