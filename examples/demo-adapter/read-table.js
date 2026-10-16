;(async () => {
  const params = window.__PARAMS__ || {}
  const table = document.querySelector('table')
  const rows = table
    ? [...table.querySelectorAll('tr')].map((row) => [...row.cells].map((cell) => cell.textContent.trim()))
    : []
  return {
    success: true,
    data: [{ title: document.title, rows, label: params.label || '' }],
    meta: { source: location.href, row_count: rows.length },
  }
})()
