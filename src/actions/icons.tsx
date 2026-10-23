// Action icons: a few line drawings, chosen by name. An unknown name shows the default bolt.

const PATHS: Record<string, string> = {
  bolt: "M13 2 4 14h7l-1 8 9-12h-7z",
  copy: "M9 9h11v11H9zM5 15H4V4h11v1",
  link: "M10 14a4 4 0 0 0 6 0l3-3a4 4 0 0 0-6-6l-1 1M14 10a4 4 0 0 0-6 0l-3 3a4 4 0 0 0 6 6l1-1",
  save: "M5 3h11l3 3v15H5zM8 3v5h7V3M8 21v-7h8v7",
  globe: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18",
  search: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM21 21l-5-5",
  mail: "M3 6h18v12H3zM3 6l9 7 9-7",
  book: "M4 4h6a2 2 0 0 1 2 2v14a2 2 0 0 0-2-2H4zM20 4h-6a2 2 0 0 0-2 2v14a2 2 0 0 1 2-2h6z",
  terminal: "M4 5h16v14H4zM7 9l3 3-3 3M12 15h5",
  edit: "M4 20h4L19 9l-4-4L4 16zM14 6l4 4",
  eye: "M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z",
  tag: "M3 3h8l10 10-8 8L3 11zM7.5 7.5h.01",
  archive: "M3 4h18v4H3zM5 8v12h14V8M10 12h4",
  file: "M6 3h8l4 4v14H6zM14 3v4h4",
  send: "M22 2 11 13M22 2l-7 20-4-9-9-4z",
  x: "M6 6l12 12M18 6 6 18",
};

export const ICONS = Object.keys(PATHS);

export default function Icon(props: { name: string }) {
  return (
    <svg class="icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d={PATHS[props.name] ?? PATHS.bolt} />
    </svg>
  );
}

export const COLORS = ["grey", "blue", "green", "yellow", "orange", "red", "purple", "teal"];
