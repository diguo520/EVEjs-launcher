/** 把行数据导成 CSV 并触发下载，导出按钮统一走这里。 */
export function downloadCsv(filename: string, headers: string[], rows: (string | number)[][]) {
  const escape = (cell: string | number) => {
    const text = String(cell ?? "")
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
  }

  const body = [headers, ...rows].map((row) => row.map(escape).join(",")).join("\n")
  // 加 BOM，Excel 打开中文表头才不乱码。写成转义序列而不是裸字符，
  // 否则会被 no-irregular-whitespace 当成异常空白。
  const blob = new Blob([String.fromCharCode(0xFEFF) + body], { type: "text/csv;charset=utf-8" })
  const url = URL.createObjectURL(blob)
  const link = document.createElement("a")
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}
