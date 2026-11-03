<#
  Fagron WHS -- συγχρονισμός αποθέματος από τη SQL του WMS στην εφαρμογή.
  Windows PowerShell 5.1+ (υπάρχει ήδη σε κάθε Windows) -- καμία εγκατάσταση.

  Τρέχει ΜΕΣΑ στο δίκτυο της Fagron. Διαβάζει το απόθεμα (μόνο ανάγνωση),
  κρατά μόνο τα συστατικά και τους τελικούς κωδικούς των προδιαγραφών και
  το ανεβάζει μέσω του ίδιου RPC με το ανέβασμα Excel (repack_replace_stock).

    .\sync-stock.cmd -Test      σύνδεση + εύρεση πινάκων/views αποθέματος
    .\sync-stock.cmd -DryRun    τρέχει το stock-query.sql, δείχνει τι θα ανέβει
    .\sync-stock.cmd            συγχρονισμός (αυτό τρέχει το Task Scheduler)
    .\sync-stock.cmd -Force     συγχρονισμός ακόμα κι αν το απόθεμα έπεσε απότομα

  Ρυθμίσεις: rythmiseis.txt (ή .env) στον ίδιο φάκελο. Ο κωδικός μένει εκεί.
#>
param([switch]$Test, [switch]$DryRun, [switch]$Force)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$Inv = [Globalization.CultureInfo]::InvariantCulture

function Log([string]$msg) {
  $line = "[{0}] {1}" -f (Get-Date -Format 'dd/MM/yyyy HH:mm:ss'), $msg
  Write-Host $line
  try { Add-Content -Path (Join-Path $Here 'sync.log') -Value $line -Encoding UTF8 } catch {}
}
function Fail([string]$msg) { Log ("ΣΦΑΛΜΑ: " + $msg); exit 1 }

# ------------------------------------------------------------------ ρυθμίσεις
$envFile = $null
foreach ($f in @('.env', 'rythmiseis.txt')) {
  $p = Join-Path $Here $f
  if (Test-Path $p) { $envFile = $p; break }
}
if (-not $envFile) { Write-Host "Δεν βρέθηκε το rythmiseis.txt στον φάκελο $Here"; exit 1 }
$Cfg = @{}
foreach ($line in [IO.File]::ReadAllLines($envFile, [Text.Encoding]::UTF8)) {
  if ($line -match '^\s*#') { continue }
  if ($line -match '^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$') { $Cfg[$Matches[1]] = $Matches[2].Trim('"', "'") }
}
function Need([string]$k) {
  if (-not $Cfg.ContainsKey($k) -or [string]::IsNullOrWhiteSpace($Cfg[$k])) { Fail "Λείπει το $k στο $(Split-Path -Leaf $envFile)" }
  return $Cfg[$k]
}
function Opt([string]$k) { if ($Cfg.ContainsKey($k)) { return $Cfg[$k] } else { return '' } }

# ------------------------------------------------------------------ SQL
function Get-ConnectionString {
  $server = Need 'WMS_SQL_SERVER'
  $instance = Opt 'WMS_SQL_INSTANCE'
  $port = Opt 'WMS_SQL_PORT'
  if ($server -notmatch '\\' -and $instance) { $server = "$server\$instance" }
  elseif ($server -notmatch '\\' -and $port) { $server = "$server,$port" }
  $encrypt = if ((Opt 'WMS_SQL_ENCRYPT') -eq 'true') { 'True' } else { 'False' }
  $b = New-Object System.Data.SqlClient.SqlConnectionStringBuilder
  $b['Data Source'] = $server
  $b['Initial Catalog'] = (Need 'WMS_SQL_DATABASE')
  $b['User ID'] = (Need 'WMS_SQL_USER')
  $b['Password'] = (Need 'WMS_SQL_PASSWORD')
  $b['ApplicationIntent'] = 'ReadOnly'
  $b['Connect Timeout'] = 20
  $b['Encrypt'] = $encrypt
  $b['TrustServerCertificate'] = $true
  $b['Application Name'] = 'Fagron WHS sync'
  return $b.ConnectionString
}

function Invoke-Sql([string]$query) {
  $conn = New-Object System.Data.SqlClient.SqlConnection (Get-ConnectionString)
  try {
    try { $conn.Open() } catch {
      $hint = ''
      if ((Opt 'WMS_SQL_INSTANCE') -or (Need 'WMS_SQL_SERVER') -match '\\') {
        $hint = ' (named instance: χρειάζεται να τρέχει η υπηρεσία «SQL Server Browser» στον server και να επιτρέπεται η UDP 1434 -- ή ζήτα από το IT σταθερή θύρα για το WMS_SQL_PORT και άδειασε το WMS_SQL_INSTANCE)'
      }
      Fail ("Σύνδεση στη SQL απέτυχε: " + $_.Exception.InnerException.Message + $_.Exception.Message + $hint)
    }
    $cmd = $conn.CreateCommand()
    $cmd.CommandText = $query
    $cmd.CommandTimeout = 120
    $table = New-Object System.Data.DataTable
    $adapter = New-Object System.Data.SqlClient.SqlDataAdapter $cmd
    [void]$adapter.Fill($table)
    return ,$table
  } finally { $conn.Close() }
}

function Strip([string]$s) {
  $d = $s.Normalize([Text.NormalizationForm]::FormD)
  $sb = New-Object Text.StringBuilder
  foreach ($ch in $d.ToCharArray()) {
    if ([Globalization.CharUnicodeInfo]::GetUnicodeCategory($ch) -ne [Globalization.UnicodeCategory]::NonSpacingMark) { [void]$sb.Append($ch) }
  }
  return $sb.ToString().ToLowerInvariant()
}

function Discover {
  $v = Invoke-Sql "select @@version as v, db_name() as db, suser_sname() as who"
  Log ("Σύνδεση OK: βάση " + $v.Rows[0].db + " ως " + $v.Rows[0].who)
  Log (($v.Rows[0].v -split "`n")[0])
  $cols = Invoke-Sql @"
select c.TABLE_SCHEMA s, c.TABLE_NAME t, t.TABLE_TYPE tt, c.COLUMN_NAME c
from INFORMATION_SCHEMA.COLUMNS c
join INFORMATION_SCHEMA.TABLES t on t.TABLE_SCHEMA = c.TABLE_SCHEMA and t.TABLE_NAME = c.TABLE_NAME
order by c.TABLE_SCHEMA, c.TABLE_NAME, c.ORDINAL_POSITION
"@
  $concepts = [ordered]@{
    'θέση'     = '(θεσ|thesi|location|^loc|_loc|bin|position|^pos|slot)'
    'είδος'    = '(ειδ|κωδ|item|sku|product|material|kwd|code)'
    'παρτίδα'  = '(παρτιδ|lot|batch|partid)'
    'ποσότητα' = '(ποσ|υπολοιπ|qty|quant|stock|amount|balance)'
    'λήξη'     = '(ληξ|expir|exp_?date|bestbefore)'
  }
  $tables = [ordered]@{}
  foreach ($r in $cols.Rows) {
    $key = "$($r.s).$($r.t)"
    if (-not $tables.Contains($key)) { $tables[$key] = @{ type = $r.tt; cols = New-Object Collections.ArrayList; hits = @{} } }
    $e = $tables[$key]
    [void]$e.cols.Add([string]$r.c)
    $n = Strip ([string]$r.c)
    foreach ($k in $concepts.Keys) { if ($n -match $concepts[$k]) { $e.hits[$k] = $true } }
  }
  $ranked = @($tables.GetEnumerator() | Where-Object { $_.Value.hits['θέση'] -and $_.Value.hits['είδος'] -and $_.Value.hits['ποσότητα'] } |
    Sort-Object @{ Expression = { $_.Value.hits.Count }; Descending = $true }, @{ Expression = { $_.Value.type -ne 'VIEW' } })
  Log ("{0} πίνακες/views. Υποψήφιοι για απόθεμα ανά θέση: {1}" -f $tables.Count, $ranked.Count)
  $out = New-Object Collections.ArrayList
  foreach ($t in ($ranked | Select-Object -First 25)) {
    $kind = if ($t.Value.type -eq 'VIEW') { 'view' } else { 'πίνακας' }
    $head = "  $($t.Key)  ($kind) · " + (($concepts.Keys | Where-Object { $t.Value.hits[$_] }) -join ', ')
    $cl = '    στήλες: ' + (($t.Value.cols -join ', '))
    if ($cl.Length -gt 400) { $cl = $cl.Substring(0, 400) + ' …' }
    Write-Host ''; Write-Host $head; Write-Host $cl
    [void]$out.Add($head); [void]$out.Add($cl)
  }
  $report = Join-Path $Here 'wms-pinakes.txt'
  [IO.File]::WriteAllLines($report, [string[]]$out, (New-Object Text.UTF8Encoding $true))
  Write-Host ''
  Write-Host "Η λίστα αποθηκεύτηκε στο $report -- στείλε τη (δεν έχει κωδικούς)."
}

# ------------------------------------------------------------------ Supabase
$SbUrl = (Need 'SUPABASE_URL').TrimEnd('/')
$SbKey = Need 'SUPABASE_ANON_KEY'
$script:Token = $null

function Sb-Request([string]$method, [string]$path, $body) {
  $h = @{ apikey = $SbKey }
  if ($script:Token) { $h['Authorization'] = "Bearer $($script:Token)" }
  $params = @{ Method = $method; Uri = "$SbUrl$path"; Headers = $h; UseBasicParsing = $true; TimeoutSec = 120 }
  if ($null -ne $body) {
    $json = ConvertTo-Json -InputObject $body -Depth 6 -Compress
    $params['Body'] = [Text.Encoding]::UTF8.GetBytes($json)
    $params['ContentType'] = 'application/json; charset=utf-8'
  }
  try {
    $res = Invoke-WebRequest @params
  } catch {
    $detail = $_.Exception.Message
    try { $detail += ' ' + (New-Object IO.StreamReader($_.Exception.Response.GetResponseStream())).ReadToEnd() } catch {}
    throw "Supabase ${method} ${path}: $detail"
  }
  $text = [Text.Encoding]::UTF8.GetString($res.RawContentStream.ToArray())
  if ([string]::IsNullOrWhiteSpace($text)) { return $null }
  return ConvertFrom-Json $text
}

function Sb-Login {
  try {
    $r = Sb-Request 'POST' '/auth/v1/token?grant_type=password' @{ email = (Need 'SYNC_EMAIL'); password = (Need 'SYNC_PASSWORD') }
  } catch { Fail ("Σύνδεση στην εφαρμογή απέτυχε ($(Need 'SYNC_EMAIL')): " + $_) }
  $script:Token = $r.access_token
}

function Sb-FetchAll([string]$table, [string]$columns) {
  $all = New-Object Collections.ArrayList
  $offset = 0
  while ($true) {
    $page = @(Sb-Request 'GET' "/rest/v1/${table}?select=$columns&offset=$offset&limit=1000" $null)
    foreach ($x in $page) { if ($null -ne $x) { [void]$all.Add($x) } }
    if ($page.Count -lt 1000) { break }
    $offset += 1000
  }
  return ,$all
}

# ------------------------------------------------------------------ μετατροπή
function To-Str($v) { if ($null -eq $v -or $v -is [DBNull]) { return '' } return ([string]$v).Trim() }
function To-Num($v) {
  if ($null -eq $v -or $v -is [DBNull]) { return $null }
  if ($v -is [decimal] -or $v -is [double] -or $v -is [int] -or $v -is [long] -or $v -is [single] -or $v -is [int16]) { return [double]$v }
  $s = (To-Str $v) -replace '\s', ''
  if (-not $s) { return $null }
  if ($s.Contains(',')) { $s = $s.Replace('.', '').Replace(',', '.') }
  $n = 0.0
  if ([double]::TryParse($s, [Globalization.NumberStyles]::Float, $Inv, [ref]$n)) { return $n }
  return $null
}
function To-Date($v) {
  if ($null -eq $v -or $v -is [DBNull]) { return $null }
  if ($v -is [DateTime]) { if ($v.Year -le 2000) { return $null } return $v.ToString('yyyy-MM-dd', $Inv) }
  $s = To-Str $v
  if ($s -match '^(\d{4})-(\d{2})-(\d{2})') { if ([int]$Matches[1] -le 2000) { return $null } return $Matches[0] }
  if ($s -match '^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})') {
    if ([int]$Matches[3] -le 2000) { return $null }
    return '{0}-{1}-{2}' -f $Matches[3], $Matches[2].PadLeft(2, '0'), $Matches[1].PadLeft(2, '0')
  }
  return $null
}

function Normalize-Rows($table) {
  $names = @($table.Columns | ForEach-Object { $_.ColumnName.ToLowerInvariant() })
  $missing = @('position', 'item', 'qty' | Where-Object { $names -notcontains $_ })
  if ($table.Rows.Count -gt 0 -and $missing.Count) { Fail ("Το stock-query.sql πρέπει να επιστρέφει στήλες με αυτά τα ονόματα: " + ($missing -join ', ')) }
  $has = @{}; foreach ($n in $names) { $has[$n] = $true }
  $merged = [ordered]@{}
  foreach ($r in $table.Rows) {
    $item = (To-Str $r['item']).ToUpperInvariant()
    $position = To-Str $r['position']
    $qty = To-Num $r['qty']
    if (-not $item -or -not $position -or $null -eq $qty -or $qty -le 0) { continue }
    $lot = if ($has['lot']) { To-Str $r['lot'] } else { '' }
    $key = "$item|$position|$lot"
    if ($merged.Contains($key)) { $merged[$key].qty = [math]::Round($merged[$key].qty + $qty, 6); continue }
    $merged[$key] = [pscustomobject][ordered]@{
      position    = $position
      area        = $(if ($has['area']) { To-Str $r['area'] } else { '' })
      item        = $item
      description = $(if ($has['description']) { To-Str $r['description'] } else { '' })
      qty         = $qty
      unit        = $(if ($has['unit']) { To-Str $r['unit'] } else { '' })
      lot         = $lot
      expiry      = $(if ($has['expiry']) { To-Date $r['expiry'] } else { $null })
    }
  }
  return ,([object[]]@($merged.Values))
}

# ------------------------------------------------------------------ main
if ($Test) { Discover; exit 0 }

$queryFile = Join-Path $Here 'stock-query.sql'
if (-not (Test-Path $queryFile)) { Fail 'Δεν βρέθηκε το stock-query.sql.' }
$query = [IO.File]::ReadAllText($queryFile, [Text.Encoding]::UTF8)
$noComments = [regex]::Replace($query, '--.*$', '', 'Multiline')
if ($noComments -match '\b(insert|update|delete|merge|drop|alter|create|truncate|exec|execute)\b') { Fail 'Το stock-query.sql επιτρέπεται να κάνει μόνο SELECT.' }

$sw = [Diagnostics.Stopwatch]::StartNew()
try { $result = Invoke-Sql $query } catch { Fail ("Το stock-query.sql απέτυχε: " + $_.Exception.Message) }
$all = Normalize-Rows $result
Log ("WMS: {0} γραμμές -> {1} με ποσότητα ({2:N1}s)" -f $result.Rows.Count, $all.Count, $sw.Elapsed.TotalSeconds)

Sb-Login
try {
  $comps = Sb-FetchAll 'repack_components' 'code'
  $recipes = Sb-FetchAll 'repack_recipes' 'product_code'
  $current = Sb-FetchAll 'repack_stock' 'item'
} catch { Fail ("Ανάγνωση από την εφαρμογή: " + $_) }

$wanted = New-Object 'Collections.Generic.HashSet[string]'
foreach ($c in $comps) { [void]$wanted.Add(([string]$c.code).ToUpperInvariant()) }
foreach ($r in $recipes) { [void]$wanted.Add(([string]$r.product_code).ToUpperInvariant()) }
$kept = [object[]]@($all | Where-Object { $wanted.Contains($_.item) })
$keptItems = @($kept | ForEach-Object { $_.item } | Select-Object -Unique).Count
Log ("Φιλτράρισμα: {0} γραμμές ({1} κωδικοί) από {2} κωδικούς προδιαγραφών · τώρα στην εφαρμογή: {3}" -f $kept.Count, $keptItems, $wanted.Count, $current.Count)

if ($DryRun) {
  $kept | Select-Object -First 15 | Format-Table -AutoSize | Out-String -Width 200 | Write-Host
  Log 'Δοκιμή (-DryRun): δεν ανέβηκε τίποτα.'
  exit 0
}

if ($kept.Count -eq 0) { Fail 'Δεν βρέθηκε απόθεμα για κανένα συστατικό -- δεν ανεβαίνει τίποτα (το απόθεμα της εφαρμογής μένει ως έχει).' }
if (-not $Force -and $current.Count -ge 20 -and $kept.Count -lt ($current.Count * 0.5)) {
  Fail ("Το απόθεμα έπεσε από {0} σε {1} γραμμές (>50%). Δεν ανέβηκε. Αν είναι σωστό: sync-stock.cmd -Force" -f $current.Count, $kept.Count)
}

try {
  [void](Sb-Request 'POST' '/rest/v1/rpc/repack_replace_stock' @{ stock = $kept; file_name = 'WMS (αυτόματος συγχρονισμός)' })
} catch { Fail ("Ανέβασμα απέτυχε: " + $_) }
Log ("OK: ανέβηκαν {0} γραμμές αποθέματος." -f $kept.Count)
