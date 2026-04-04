export default function Home() {
  return (
    <main style={{ padding: "2rem", fontFamily: "system-ui" }}>
      <h1>⚙️ Depozitka Engine</h1>
      <p>Backend worker — nothing to see here.</p>
      <p>
        <a href="/api/cron/daily-jobs">Run daily jobs (requires auth)</a>
      </p>
    </main>
  );
}
