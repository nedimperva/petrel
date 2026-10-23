// Starting points for a new action in the editor. Steps list only the fields that differ from a new step of
// their type; the editor fills the rest. Commands assume a usual Linux shell; each says what it needs.

import type { Action, Step } from "../api";

export interface Example {
  name: string;
  icon: string;
  color: string;
  description: string;
  steps: Step[];
  more?: Partial<Action>;
}

export const SIMPLE: Example[] = [
  {
    name: "Save to my notes folder",
    icon: "save",
    color: "green",
    description: "Saves the draft as a Markdown file named after its title.",
    steps: [{ type: "file", path: "~/Notes/[[safe_title]].md", mode: "overwrite" }],
  },
  {
    name: "Add to a todo file",
    icon: "file",
    color: "orange",
    description: "Adds the draft as a task at the end of todo.md.",
    steps: [{ type: "file", path: "~/Notes/todo.md", text: "- [ ] [[draft]]\n", mode: "append" }],
  },
  {
    name: "Copy as a quote",
    icon: "copy",
    color: "blue",
    description: "Copies the draft as a Markdown quote with today's date.",
    steps: [{ type: "clipboard", text: "> [[draft]]\n\n— [[date]]" }],
  },
  {
    name: "Look up on Wikipedia",
    icon: "globe",
    color: "teal",
    description: "Searches Wikipedia for the selection, or the whole draft.",
    steps: [{ type: "url", url: "https://en.wikipedia.org/w/index.php?search=[[selection]]" }],
  },
];

export const ADVANCED: Example[] = [
  {
    name: "File a meeting note",
    icon: "book",
    color: "purple",
    description: "Asks which project, saves the note under that project's folder with today's date, tags it and archives it.",
    steps: [
      {
        type: "prompt",
        title: "File meeting note",
        buttons: ["File"],
        fields: [{ key: "project", kind: "select", label: "Project", default: "work", options: ["work", "home", "side"] }],
      },
      { type: "file", path: "~/Notes/[[prompt_project]]/meetings/[[date]] [[safe_title]].md", mode: "create" },
      { type: "setTags", add: ["meeting", "[[prompt_project]]"] },
    ],
    more: { afterSuccess: "archive" },
  },
  {
    name: "Save and commit to git",
    icon: "save",
    color: "green",
    description: "Saves the draft into a git repository and commits it with the title as the message. Needs git and a repo at ~/Notes.",
    steps: [
      { type: "file", path: "~/Notes/[[safe_title]].md", mode: "overwrite" },
      // The message goes in on stdin, so quotes in a title cannot break the command.
      { type: "runCommand", command: "git add -A && git commit -q -F -", stdin: "[[title]]", cwd: "~/Notes" },
    ],
  },
  {
    name: "Word count",
    icon: "eye",
    color: "grey",
    description: "Counts words and lines with wc and shows the result. Shows how a command's output becomes a tag.",
    steps: [
      { type: "runCommand", command: "wc -w | tr -d ' '", output: "templateTag:words" },
      { type: "runCommand", command: "wc -l | tr -d ' '", output: "templateTag:lines" },
      { type: "prompt", title: "[[title]]", message: "[[words]] words, [[lines]] lines.", buttons: ["OK"], fields: [], cancelButton: false },
    ],
  },
  {
    name: "Calculate the selection",
    icon: "terminal",
    color: "grey",
    description: "Select a sum like 12*7, run it, and the answer follows: 12*7 = 84. Needs bc.",
    steps: [{ type: "runCommand", command: "printf ' = %s' \"$( (cat; echo) | bc -l)\"", stdin: "[[selection_only]]", output: "insert" }],
  },
  {
    name: "Pretty-print JSON",
    icon: "edit",
    color: "teal",
    description: "Formats the draft as indented JSON with jq, in place. If jq finds an error, the draft is left as it was.",
    steps: [{ type: "runCommand", command: "jq .", output: "replace" }],
  },
  {
    name: "Rewrite with an LLM",
    icon: "send",
    color: "purple",
    description: "Sends the draft to the llm command line tool with your instruction and replaces the text with the answer. Needs llm (llm.datasette.io).",
    steps: [
      {
        type: "prompt",
        title: "Rewrite",
        buttons: ["Rewrite"],
        fields: [{ key: "how", kind: "text", label: "How", default: "Make it shorter and clearer", options: [] }],
      },
      {
        type: "runCommand",
        command: "llm",
        stdin: "[[prompt_how]]. Reply with the rewritten text only.\n\n[[draft]]",
        output: "replace",
        timeoutSecs: 60,
      },
    ],
  },
  {
    name: "Review, then publish",
    icon: "eye",
    color: "orange",
    description: "Shows the draft rendered. Continue saves it as a blog post with front matter (title, date, tags).",
    steps: [
      { type: "htmlPreview", continueButton: true },
      {
        type: "file",
        path: "~/Blog/content/posts/[[date]]-[[safe_title]].md",
        text: '---\ntitle: "[[title]]"\ndate: [[date|%Y-%m-%dT%H:%M:%S]]\ntags: [[[tags]]]\n---\n\n[[trimmed_body]]\n',
        mode: "create",
      },
    ],
  },
  {
    name: "Tomorrow's task",
    icon: "tag",
    color: "red",
    description: "Adds the first line to tomorrow's daily note as a task and tags the draft.",
    steps: [
      { type: "file", path: "~/Notes/Daily/[[date|+1 day]].md", text: "- [ ] [[title]]\n", mode: "append" },
      { type: "setTags", add: ["scheduled"] },
    ],
  },
];
