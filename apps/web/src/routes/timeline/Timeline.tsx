export function Timeline() {
  return (
    <div className="p-4">
      <h2 className="text-lg font-semibold mb-2">Timeline</h2>
      <p className="text-neutral-500 text-sm">
        Canvas-rendered timeline with event pins lands in M2. For now, playback is served directly
        from recorded fMP4 segments at <code>/var/lib/fnvr/recordings/</code>.
      </p>
    </div>
  );
}
