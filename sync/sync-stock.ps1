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
    .\sync-stock.cmd -Describe Pos   όλες οι στήλες των πινάκων με «Pos» στο όνομα
    .\sync-stock.cmd -Probe 71-01-359 -Find 75   όλες οι τιμές ενός είδους στους πίνακες του WMS
    .\sync-stock.cmd -Moves     εύρεση πινάκων κινήσεων (-> wms-kiniseis.txt)
    .\sync-stock.cmd -Live      τρέχει συνέχεια: νέες κινήσεις + απόθεμα όσων κινήθηκαν, κάθε 30"

  Κινήσεις: αν υπάρχει το movements-query.sql, κάθε συγχρονισμός ανεβάζει και τις
  ΝΕΕΣ κινήσεις (από την τελευταία που υπάρχει στην εφαρμογή, αρχικά MOVES_DAYS ημέρες).

  Ρυθμίσεις: rythmiseis.txt (ή .env) στον ίδιο φάκελο. Ο κωδικός μένει εκεί.
#>
param([switch]$Test, [switch]$DryRun, [switch]$Force, [string]$Describe, [string]$Probe, [string]$Find, [switch]$Moves, [switch]$Live, [switch]$Orders)

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

function Invoke-Sql([string]$query, [hashtable]$params = @{}) {
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
    foreach ($k in $params.Keys) { [void]$cmd.Parameters.AddWithValue("@$k", $params[$k]) }
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

function Describe-Tables([string]$pattern) {
  $safe = $pattern -replace "[^A-Za-z0-9_]", ''
  if (-not $safe) { Fail 'Δώσε μέρος του ονόματος πίνακα, π.χ. -Describe Pos' }
  $cols = Invoke-Sql @"
select c.TABLE_SCHEMA s, c.TABLE_NAME t, t.TABLE_TYPE tt, c.COLUMN_NAME c, c.DATA_TYPE dt
from INFORMATION_SCHEMA.COLUMNS c
join INFORMATION_SCHEMA.TABLES t on t.TABLE_SCHEMA = c.TABLE_SCHEMA and t.TABLE_NAME = c.TABLE_NAME
where c.TABLE_NAME like '%$safe%'
order by c.TABLE_SCHEMA, c.TABLE_NAME, c.ORDINAL_POSITION
"@
  $out = New-Object Collections.ArrayList
  $last = ''
  foreach ($r in $cols.Rows) {
    $key = "$($r.s).$($r.t)"
    if ($key -ne $last) {
      $kind = if ($r.tt -eq 'VIEW') { 'view' } else { 'πίνακας' }
      [void]$out.Add(''); [void]$out.Add("  $key ($kind)")
      $last = $key
    }
    [void]$out.Add("    $($r.c)  [$($r.dt)]")
  }
  if (-not $out.Count) { Log "Κανένας πίνακας με «$safe» στο όνομα."; return }
  $out | ForEach-Object { Write-Host $_ }
  $report = Join-Path $Here 'wms-pinakes.txt'
  [IO.File]::WriteAllLines($report, [string[]]$out, (New-Object Text.UTF8Encoding $true))
  Write-Host ''
  Write-Host "Αποθηκεύτηκε στο $report -- στείλε το (δεν έχει κωδικούς)."
}

function Probe-Item([string]$code, [string]$find) {
  $it = Invoke-Sql "select top 1 ID from dbo.ms_Item where code = @code" @{ code = $code }
  if (-not $it.Rows.Count) { Fail "Δεν βρέθηκε ο κωδικός $code στο dbo.ms_Item" }
  $id = $it.Rows[0].ID
  Log "Είδος $code -> ID $id"
  # όλοι οι πίνακες με στήλη είδους (ItemId / ID στον ms_Item*), εκτός από κινήσεις/ιστορικό
  $tabs = Invoke-Sql @"
select c.TABLE_SCHEMA s, c.TABLE_NAME t, c.COLUMN_NAME c
from INFORMATION_SCHEMA.COLUMNS c
join INFORMATION_SCHEMA.TABLES t on t.TABLE_SCHEMA = c.TABLE_SCHEMA and t.TABLE_NAME = c.TABLE_NAME and t.TABLE_TYPE = 'BASE TABLE'
where (c.COLUMN_NAME in ('ItemId', 'ItemID') or (c.TABLE_NAME in ('ms_Item', 'ms_ItemZ') and c.COLUMN_NAME = 'ID'))
  and c.TABLE_NAME not like '%Trans%' and c.TABLE_NAME not like '%backup%' and c.TABLE_NAME not like '%Inventory%'
  and c.TABLE_NAME not like '%Log%' and c.TABLE_NAME not like '%Stock%' and c.TABLE_NAME not like '%Order%'
order by c.TABLE_NAME
"@
  $out = New-Object Collections.ArrayList
  foreach ($t in $tabs.Rows) {
    $tn = "[$($t.s)].[$($t.t)]"; $cn = "[$($t.c)]"
    try { $rows = Invoke-Sql "select top 5 * from $tn where $cn = @id" @{ id = $id } } catch { continue }
    if (-not $rows.Rows.Count) { continue }
    [void]$out.Add(''); [void]$out.Add("  $($t.s).$($t.t)  ($($rows.Rows.Count) γραμμές)")
    foreach ($r in $rows.Rows) {
      foreach ($col in $rows.Columns) {
        $v = $r[$col.ColumnName]
        if ($null -eq $v -or $v -is [DBNull]) { continue }
        $sv = if ($v -is [double] -or $v -is [decimal] -or $v -is [single]) { ([double]$v).ToString($Inv) } else { [string]$v }
        if ($sv -eq '' -or $sv -eq '0' -or $sv -eq 'False') { continue }
        if ($sv.Length -gt 120) { $sv = $sv.Substring(0, 120) + ' …' }
        $mark = if ($find -and ($sv -eq $find -or $sv -eq "$find.0")) { '   <<<<<< ' + $find } else { '' }
        [void]$out.Add("    $($col.ColumnName) = $sv$mark")
      }
      [void]$out.Add('    ---')
    }
  }
  $out | ForEach-Object { Write-Host $_ }
  $report = Join-Path $Here 'wms-pinakes.txt'
  [IO.File]::WriteAllLines($report, [string[]]$out, (New-Object Text.UTF8Encoding $true))
  Write-Host ''
  Write-Host "Αποθηκεύτηκε στο $report -- στείλε το (έχει μόνο στοιχεία του είδους, όχι κωδικούς πρόσβασης)."
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
  # Windows PowerShell 5.1: το ConvertFrom-Json δίνει έναν πίνακα JSON ως ΕΝΑ αντικείμενο --
  # αποθήκευση σε μεταβλητή + return τον «ξεδιπλώνει» σε στοιχεία (ίδια συμπεριφορά με το PS 7).
  $parsed = ConvertFrom-Json $text
  return $parsed
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
      # χωρίς παρτίδα = χωρίς λήξη (το WMS βάζει εκεί άσχετες ημερομηνίες)
      expiry      = $(if ($has['expiry'] -and $lot) { To-Date $r['expiry'] } else { $null })
    }
  }
  return ,([object[]]@($merged.Values))
}

# ------------------------------------------------------------------ στοιχεία ετικέτας
# Αγγλική περιγραφή των τελικών κωδικών (ms_Item.AlterDescr) -> εφαρμογή (για τις ετικέτες).
# Το query αλλάζει με αρχείο item-query.sql (στήλες: code, description_en [, units_per_package]).
function Get-ItemInfo($finals) {
  $q = "select i.code as code, i.AlterDescr as description_en from dbo.ms_Item i where i.AlterDescr is not null and ltrim(rtrim(i.AlterDescr)) <> ''"
  $custom = Join-Path $Here 'item-query.sql'
  if (Test-Path $custom) {
    $q = [IO.File]::ReadAllText($custom, [Text.Encoding]::UTF8)
    if ([regex]::Replace($q, '--.*$', '', 'Multiline') -match '\b(insert|update|delete|merge|drop|alter|create|truncate|exec|execute)\b') { Log 'item-query.sql: επιτρέπεται μόνο SELECT -- παραλείπεται'; return @() }
  }
  try { $t = Invoke-Sql $q } catch { Log ("Αγγλικές περιγραφές: το query απέτυχε (" + $_.Exception.Message + ") -- παραλείπεται"); return @() }
  $hasUpp = $t.Columns.Contains('units_per_package')
  $out = New-Object Collections.ArrayList
  foreach ($r in $t.Rows) {
    $code = (To-Str $r['code']).ToUpperInvariant()
    if (-not $finals.Contains($code)) { continue }
    $en = To-Str $r['description_en']
    # το AlterDescr έχει συχνά ξανά ελληνικά -- κρατάμε μόνο λατινικά (αλλιώς η εφαρμογή βγάζει αυτόματη μετάφραση)
    if ($en -match '[\u0370-\u03FF\u1F00-\u1FFF]') { $en = '' }
    $o = [ordered]@{ code = $code; description_en = $en }
    if ($hasUpp) { $u = To-Num $r['units_per_package']; if ($null -ne $u -and $u -gt 0) { $o['units_per_package'] = [int][math]::Round($u) } }
    [void]$out.Add([pscustomobject]$o)
  }
  return ,([object[]]$out.ToArray())
}

# ------------------------------------------------------------------ γενικές ετικέτες (όλοι οι κωδικοί)
# Κατάλογος κωδικών + απόθεμα ανά παρτίδα / serial για τη σελίδα Ετικέτες -> «Όλα τα προϊόντα».
function Find-SerialColumns {
  try {
    $t = Invoke-Sql "select TABLE_NAME as t, COLUMN_NAME as c from INFORMATION_SCHEMA.COLUMNS where COLUMN_NAME like '%serial%' or COLUMN_NAME like '%SerNo%' or COLUMN_NAME like '%SerialN%' or COLUMN_NAME like 'SN' or COLUMN_NAME like '%[_]SN' or COLUMN_NAME like '%Seiriak%' order by TABLE_NAME, COLUMN_NAME"
    return ,([object[]]@($t.Rows | ForEach-Object { [pscustomobject]@{ table = To-Str $_['t']; column = To-Str $_['c'] } }))
  } catch { return ,([object[]]@()) }
}

function Get-GeneralStock($result) {
  $names = @($result.Columns | ForEach-Object { $_.ColumnName.ToLowerInvariant() })
  if ($names -contains 'serial') { return ,$result }
  $cols = Find-SerialColumns
  if ($cols.Count) { Log ("Στήλες serial στο WMS: " + (($cols | ForEach-Object { "$($_.table).$($_.column)" }) -join ', ')) }
  else { Log 'Στήλες serial στο WMS: δεν βρέθηκε καμία (τα serial θα διαβάζονται από το πεδίο Παρτίδα)' }
  $sc = @($cols | Where-Object { $_.table -eq 'ms_Stock' -and $_.column -match '^[A-Za-z0-9_]+$' } | Select-Object -First 1)
  if (-not $sc.Count) { return ,$result }
  $col = $sc[0].column
  $q = "select p.code as position, p.Descr as area, i.code as item, i.Descr as description, s.Qty1 as qty, s.Lot as lot, s.ExpDate as expiry, s.[$col] as serial from dbo.ms_Stock s join dbo.ms_Item i on i.ID = s.ItemId join dbo.ms_Pos p on p.ID = s.PosId where s.Qty1 > 0"
  try { $t = Invoke-Sql $q; Log ("Serial: από ms_Stock.$col"); return ,$t } catch { Log ("Serial: το query απέτυχε (" + $_.Exception.Message + ") -- χωρίς serial"); return ,$result }
}

function Aggregate-Stock($table) {
  $names = @($table.Columns | ForEach-Object { $_.ColumnName.ToLowerInvariant() })
  $has = @{}; foreach ($n in $names) { $has[$n] = $true }
  $stock = [ordered]@{}
  $desc = @{}
  foreach ($r in $table.Rows) {
    $item = (To-Str $r['item']).ToUpperInvariant()
    $qty = To-Num $r['qty']
    if (-not $item -or $null -eq $qty -or $qty -le 0) { continue }
    $lot = if ($has['lot']) { To-Str $r['lot'] } else { '' }
    $serial = if ($has['serial']) { To-Str $r['serial'] } else { '' }
    $pos = if ($has['position']) { To-Str $r['position'] } else { '' }
    $area = if ($has['area']) { To-Str $r['area'] } else { '' }
    $exp = if ($has['expiry'] -and $lot) { To-Date $r['expiry'] } else { $null }
    if ($has['description'] -and -not $desc.ContainsKey($item)) { $desc[$item] = To-Str $r['description'] }
    # μία γραμμή ανά κωδικό + θέση + παρτίδα + serial (για τη σελίδα «Απόθεμα»)
    $key = "$item|$pos|$lot|$serial"
    if ($stock.Contains($key)) {
      $o = $stock[$key]
      $o.qty = [math]::Round($o.qty + $qty, 6)
      if ($exp -and (-not $o.expiry -or $exp -lt $o.expiry)) { $o.expiry = $exp }
      continue
    }
    $stock[$key] = [pscustomobject][ordered]@{ item = $item; position = $pos; area = $area; lot = $lot; serial = $serial; expiry = $exp; qty = $qty }
  }
  return @{ rows = [object[]]@($stock.Values); desc = $desc }
}

function Build-General($table) {
  $agg = Aggregate-Stock $table
  $rows = $agg.rows; $desc = $agg.desc
  # κατάλογος: όλοι οι κωδικοί του ms_Item (αν διαβάζεται), αλλιώς όσοι έχουν απόθεμα
  $items = New-Object Collections.ArrayList
  try {
    $t = Invoke-Sql "select i.code as code, i.Descr as description, i.AlterDescr as description_en from dbo.ms_Item i where i.code is not null"
    foreach ($r in $t.Rows) {
      $code = (To-Str $r['code']).ToUpperInvariant(); if (-not $code) { continue }
      $en = To-Str $r['description_en']; if ($en -match '[Ͱ-Ͽἀ-῿]') { $en = '' }
      [void]$items.Add([pscustomobject]@{ code = $code; description = (To-Str $r['description']); description_en = $en })
    }
  } catch {
    Log ("Κατάλογος ms_Item: απέτυχε (" + $_.Exception.Message + ") -- μόνο κωδικοί με απόθεμα")
    foreach ($k in $desc.Keys) { [void]$items.Add([pscustomobject]@{ code = $k; description = $desc[$k]; description_en = '' }) }
  }
  return @{ stock = [object[]]@($rows); items = [object[]]$items.ToArray() }
}

function Upload-General($g) {
  $size = 2000
  $stock = $g.stock; $items = $g.items
  $chunks = [math]::Max([math]::Ceiling($stock.Count / $size), [math]::Ceiling($items.Count / $size))
  for ($i = 0; $i -lt [math]::Max(1, $chunks); $i++) {
    $s = @(); $it = @()
    if ($i * $size -lt $stock.Count) { $s = $stock[($i * $size)..([math]::Min($stock.Count, ($i + 1) * $size) - 1)] }
    if ($i * $size -lt $items.Count) { $it = $items[($i * $size)..([math]::Min($items.Count, ($i + 1) * $size) - 1)] }
    [void](Sb-Request 'POST' '/rest/v1/rpc/wms_upload' @{ p_items = [object[]]@($it); p_stock = [object[]]@($s); p_first = ($i -eq 0) })
  }
}

# ------------------------------------------------------------------ κινήσεις
# Εύρεση: πίνακες με όνομα σαν κινήσεις/παραστατικά, στήλες + 3 πρόσφατες γραμμές.
function Discover-Moves {
  $tabs = Invoke-Sql @"
select t.TABLE_SCHEMA s, t.TABLE_NAME t,
       (select sum(p.rows) from sys.partitions p where p.object_id = object_id(quotename(t.TABLE_SCHEMA) + '.' + quotename(t.TABLE_NAME)) and p.index_id in (0, 1)) n
from INFORMATION_SCHEMA.TABLES t
where t.TABLE_TYPE = 'BASE TABLE'
  and (t.TABLE_NAME like '%Trans%' or t.TABLE_NAME like '%Mov%' or t.TABLE_NAME like '%Kin%' or t.TABLE_NAME like '%Hist%'
    or t.TABLE_NAME like '%Order%' or t.TABLE_NAME like '%Doc%' or t.TABLE_NAME like '%Pick%' or t.TABLE_NAME like '%Recei%'
    or t.TABLE_NAME like '%Ship%' or t.TABLE_NAME like '%Disp%' or t.TABLE_NAME like '%Cust%' or t.TABLE_NAME like '%Trader%'
    or t.TABLE_NAME like '%Partner%' or t.TABLE_NAME like '%Client%' or t.TABLE_NAME like '%Task%' or t.TABLE_NAME like '%Log%')
order by n desc
"@
  $out = New-Object Collections.ArrayList
  [void]$out.Add("Πίνακες που μοιάζουν με κινήσεις / παραστατικά / πελάτες (γραμμές):")
  foreach ($t in $tabs.Rows) { [void]$out.Add(("  {0}.{1}  ({2})" -f $t.s, $t.t, $t.n)) }
  $i = 0
  foreach ($t in $tabs.Rows) {
    if ($i -ge 25) { break }
    if (-not ($t.n -gt 0)) { continue }
    $i++
    $tn = "[$($t.s)].[$($t.t)]"
    $cols = Invoke-Sql "select COLUMN_NAME c, DATA_TYPE dt from INFORMATION_SCHEMA.COLUMNS where TABLE_SCHEMA = @s and TABLE_NAME = @t order by ORDINAL_POSITION" @{ s = [string]$t.s; t = [string]$t.t }
    [void]$out.Add(''); [void]$out.Add("== $($t.s).$($t.t)  ($($t.n) γραμμές)")
    [void]$out.Add('   στήλες: ' + (($cols.Rows | ForEach-Object { "$($_.c) [$($_.dt)]" }) -join ', '))
    $dcol = @($cols.Rows | Where-Object { $_.dt -match 'date|time' } | Select-Object -First 1)
    $order = if ($dcol.Count) { " order by [$($dcol[0].c)] desc" } else { '' }
    try { $rows = Invoke-Sql "select top 3 * from $tn$order" } catch { [void]$out.Add('   (δεν διαβάζεται)'); continue }
    foreach ($r in $rows.Rows) {
      $vals = foreach ($c in $rows.Columns) {
        $v = $r[$c.ColumnName]
        if ($null -eq $v -or $v -is [DBNull]) { continue }
        $sv = if ($v -is [DateTime]) { $v.ToString('yyyy-MM-dd HH:mm', $Inv) } elseif ($v -is [double] -or $v -is [decimal]) { ([double]$v).ToString($Inv) } else { [string]$v }
        if ($sv -eq '' -or $sv.Length -gt 60) { continue }
        "$($c.ColumnName)=$sv"
      }
      [void]$out.Add('   · ' + ($vals -join ' | '))
    }
  }
  $out | ForEach-Object { Write-Host $_ }
  $report = Join-Path $Here 'wms-kiniseis.txt'
  [IO.File]::WriteAllLines($report, [string[]]$out, (New-Object Text.UTF8Encoding $true))
  Write-Host ''
  Write-Host "Αποθηκεύτηκε στο $report -- στείλε το (δεν έχει κωδικούς πρόσβασης)."
}

# Συγχρονισμός κινήσεων: movements-query.sql με παράμετρο @since, στήλες
# id, moved_at, type, doc, item, lot, serial, qty, from_pos, to_pos, customer, username
# Αυτόματο query για το ms_StockTrans του WMS (EnterLab): συνδέει μόνο όσους
# πίνακες υπάρχουν (πελάτης: ms_Person, χρήστης: ms_User/ms_Users), για να μη σπάει.
function Build-MovesQuery([string]$where = 's.RecDate >= cast(@since as date)') {
  $cols = Invoke-Sql "select TABLE_NAME t, COLUMN_NAME c from INFORMATION_SCHEMA.COLUMNS where TABLE_SCHEMA = 'dbo' and TABLE_NAME in ('ms_StockTrans','ms_TransCode','ms_Person','ms_Persons','ms_User','ms_Users')"
  $has = @{}
  foreach ($r in $cols.Rows) { $t = [string]$r.t; if (-not $has.ContainsKey($t)) { $has[$t] = New-Object 'Collections.Generic.List[string]' }; $has[$t].Add([string]$r.c) }
  if (-not $has.ContainsKey('ms_StockTrans')) { return $null }
  $pick = { param($t, $names) if (-not $has.ContainsKey($t)) { return $null }; foreach ($n in $names) { $m = @($has[$t] | Where-Object { $_ -ieq $n }); if ($m.Count) { return $m[0] } }; return $null }
  $sel = New-Object Collections.ArrayList
  $join = New-Object Collections.ArrayList
  [void]$sel.Add("cast(s.ID as varchar(30)) as id")
  [void]$sel.Add("cast(cast(s.RecDate as date) as datetime) + cast(cast(s.RecTime as time) as datetime) as moved_at")
  if ($has.ContainsKey('ms_TransCode')) { [void]$sel.Add("coalesce(tc.Descr, s.TransCode) as type"); [void]$join.Add("left join dbo.ms_TransCode tc on tc.code = s.TransCode") }
  else { [void]$sel.Add("s.TransCode as type") }
  [void]$sel.Add("coalesce(nullif(s.ErpKey, ''), case when s.RelListId > 0 then cast(s.RelListId as varchar(20)) end) as doc")
  [void]$sel.Add("i.code as item"); [void]$join.Add("left join dbo.ms_Item i on i.ID = s.ItemId")
  [void]$sel.Add("s.Lot as lot"); [void]$sel.Add("s.sn as serial"); [void]$sel.Add("s.Qty1 as qty")
  [void]$sel.Add("pf.code as from_pos"); [void]$join.Add("left join dbo.ms_Pos pf on pf.ID = s.FromPosId")
  [void]$sel.Add("pt.code as to_pos"); [void]$join.Add("left join dbo.ms_Pos pt on pt.ID = s.ToPosId")
  foreach ($pt in 'ms_Person', 'ms_Persons') {
    $nc = & $pick $pt @('Descr', 'Name', 'Title', 'Eponymia', 'FullName', 'Code')
    if ($nc) { [void]$sel.Add("pe.[$nc] as customer"); [void]$join.Add("left join dbo.$pt pe on pe.ID = s.PersonId"); break }
  }
  foreach ($ut in 'ms_User', 'ms_Users') {
    $nc = & $pick $ut @('UserName', 'Name', 'Descr', 'Code', 'Login')
    if ($nc) { [void]$sel.Add("us.[$nc] as username"); [void]$join.Add("left join dbo.$ut us on us.ID = s.UserId"); break }
  }
  return "select " + ($sel -join ",`r`n       ") + "`r`nfrom dbo.ms_StockTrans s`r`n" + ($join -join "`r`n") + "`r`nwhere $where"
}

function Sync-Moves {
  $file = Join-Path $Here 'movements-query.sql'
  if (Test-Path $file) { $q = [IO.File]::ReadAllText($file, [Text.Encoding]::UTF8) }
  else {
    try { $q = Build-MovesQuery } catch { Log ("Κινήσεις: " + $_.Exception.Message); return }
    if (-not $q) { return }
    # για έλεγχο / αλλαγές: μετονόμασέ το σε movements-query.sql και άλλαξέ το
    [IO.File]::WriteAllText((Join-Path $Here 'movements-query.auto.sql'), $q, (New-Object Text.UTF8Encoding $true))
  }
  if ([regex]::Replace($q, '--.*$', '', 'Multiline') -match '\b(insert|update|delete|merge|drop|alter|create|truncate|exec|execute)\b') { Log 'movements-query.sql: επιτρέπεται μόνο SELECT -- παραλείπεται'; return }
  $last = $null
  try { $last = Sb-Request 'POST' '/rest/v1/rpc/wms_moves_last' @{} } catch { Log ("Κινήσεις: " + $_); return }
  $days = 180; $o = Opt 'MOVES_DAYS'; if ($o -match '^\d+$') { $days = [int]$o }
  $since = if ($last) { ([DateTime]::Parse([string]$last, $Inv)).ToLocalTime().AddDays(-2) } else { (Get-Date).Date.AddDays(-$days) }
  try { $t = Invoke-Sql $q @{ since = $since } } catch { Log ("Κινήσεις: το query απέτυχε (" + $_.Exception.Message + ")"); return }
  $names = @($t.Columns | ForEach-Object { $_.ColumnName.ToLowerInvariant() })
  if ($names -notcontains 'id' -or $names -notcontains 'moved_at') { Log 'Κινήσεις: το movements-query.sql πρέπει να επιστρέφει τουλάχιστον id και moved_at'; return }
  $has = @{}; foreach ($n in $names) { $has[$n] = $true }
  # πρώτη φορά μπορεί να είναι πολλές: έως MOVES_MAX ανά συγχρονισμό (οι παλαιότερες
  # πρώτα), οι υπόλοιπες ανεβαίνουν στους επόμενους -- συνεχίζει από την τελευταία
  $max = 40000; $o = Opt 'MOVES_MAX'; if ($o -match '^\d+$') { $max = [int]$o }
  $more = $false
  if ($t.Rows.Count -gt $max) {
    $t.DefaultView.Sort = 'moved_at ASC'
    $sorted = $t.DefaultView.ToTable()
    $t = $sorted.Clone()
    for ($k = 0; $k -lt $max; $k++) { [void]$t.ImportRow($sorted.Rows[$k]) }
    $more = $true
  }
  $rows = Convert-Moves $t
  if (-not (Upload-Moves $rows)) { return }
  Log ("Κινήσεις: {0} από {1:dd/MM/yyyy HH:mm} και μετά{2}." -f $rows.Count, $since, $(if ($more) { ' -- υπάρχουν κι άλλες, συνεχίζει στον επόμενο συγχρονισμό' } else { '' }))
  if ($rows.Count) { try { [void](Sb-Request 'POST' '/rest/v1/rpc/wms_signal' @{ p_key = 'moves'; p_n = $rows.Count }) } catch {} }
}

# Μία φορά: κινήσεις από 01/01/2026 έως εκεί που ξεκινούσε το αρχικό sync (για αναφορές έτους).
function Backfill-Moves {
  $mark = Join-Path $Here 'moves-backfill-20260101.done'
  if (Test-Path $mark) { return }
  $from = [DateTime]'2026-01-01'; $until = [DateTime]'2026-05-10'
  $total = 0
  for ($d = $from; $d -lt $until; $d = $d.AddMonths(1)) {
    $e = $d.AddMonths(1); if ($e -gt $until) { $e = $until }
    $q = Build-MovesQuery ("s.RecDate >= '{0:yyyyMMdd}' and s.RecDate < '{1:yyyyMMdd}'" -f $d, $e)
    $rows = Convert-Moves (Invoke-Sql $q)
    if ($rows.Count -and -not (Upload-Moves $rows)) { Log 'Κινήσεις (αναδρομικά): διακοπή στο ανέβασμα'; return }
    $total += $rows.Count
  }
  Set-Content -Path $mark -Value (Get-Date -Format s) -Encoding UTF8
  Log ("Κινήσεις (αναδρομικά από 01/01/2026): {0} γραμμές" -f $total)
}

# Ποσότητα ανά παλέτα / μονάδες συσκευασίας από το ms_Item + ms_ItemUnit (μία φορά την ώρα).
function Sync-ItemPack {
  $mark = Join-Path $Here 'itempack.last'
  if ((Test-Path $mark) -and ((Get-Item $mark).LastWriteTime -gt (Get-Date).AddMinutes(-55))) { return }
  $units = @{}
  try {
    $u = Invoke-Sql "select i.code as code, u.PackId as pack, u.Rel as rel from dbo.ms_ItemUnit u join dbo.ms_Item i on i.ID = u.ItemID where u.Rel > 1"
    foreach ($r in $u.Rows) {
      $c = (To-Str $r['code']).ToUpperInvariant(); if (-not $c) { continue }
      $x = '{0}:{1}' -f (To-Str $r['pack']), ([double](To-Num $r['rel'])).ToString($Inv)
      $units[$c] = if ($units.ContainsKey($c)) { $units[$c] + ';' + $x } else { $x }
    }
  } catch { Log ("Παλέτες (μονάδες): " + $_.Exception.Message) }
  $t = Invoke-Sql "select i.code as code, i.PiecesPerPalete as ppp, i.PalPiecesToMu1 as p2m from dbo.ms_Item i where i.code is not null"
  $rows = New-Object Collections.ArrayList
  foreach ($r in $t.Rows) {
    $c = (To-Str $r['code']).ToUpperInvariant(); if (-not $c) { continue }
    $ppp = To-Num $r['ppp']; $p2m = To-Num $r['p2m']; $un = if ($units.ContainsKey($c)) { $units[$c] } else { '' }
    if (($ppp -gt 1) -or ($p2m -gt 1) -or $un) {
      [void]$rows.Add(@{ item = $c; ppp = $(if ($null -ne $ppp) { ([double]$ppp).ToString($Inv) } else { '' }); p2m = $(if ($null -ne $p2m) { ([double]$p2m).ToString($Inv) } else { '' }); units = $un })
    }
  }
  $packs = @()
  foreach ($tb in 'ms_Pack', 'ms_Packs', 'ms_PackType', 'ms_Unit') {
    try {
      $pt = Invoke-Sql "select top 200 * from dbo.$tb"
      $cols = @($pt.Columns | ForEach-Object { $_.ColumnName })
      if ($cols -notcontains 'ID') { continue }
      $cc = @($cols | Where-Object { $_ -match '^(code|Code)$' }); $dc = @($cols | Where-Object { $_ -match '^(Descr|descr|Description)$' })
      $packs = @($pt.Rows | ForEach-Object { @{ id = [int](To-Num $_['ID']); code = $(if ($cc.Count) { To-Str $_[$cc[0]] } else { '' }); descr = $(if ($dc.Count) { To-Str $_[$dc[0]] } else { '' }) } })
      break
    } catch { }
  }
  $n = Sb-Request 'POST' '/rest/v1/rpc/wms_item_pack_upload' @{ p_rows = [object[]]$rows.ToArray(); p_packs = [object[]]$packs }
  Set-Content -Path $mark -Value (Get-Date -Format s) -Encoding UTF8
  Log ("Παλέτες / συσκευασίες: {0} κωδικοί, {1} τύποι μονάδων" -f $n, $packs.Count)
}

function Convert-Moves($t) {
  $names = @($t.Columns | ForEach-Object { $_.ColumnName.ToLowerInvariant() })
  $has = @{}; foreach ($n in $names) { $has[$n] = $true }
  $col = { param($r, $n) if ($has[$n]) { To-Str $r[$n] } else { '' } }
  $rows = New-Object Collections.ArrayList
  foreach ($r in $t.Rows) {
    $at = $r['moved_at']
    $atS = if ($at -is [DateTime]) { $at.ToString('yyyy-MM-ddTHH:mm:ss', $Inv) + ([DateTimeOffset]::new($at)).ToString('zzz') } else { To-Str $at }
    [void]$rows.Add([pscustomobject][ordered]@{
      id = (& $col $r 'id'); moved_at = $atS; type = (& $col $r 'type'); doc = (& $col $r 'doc')
      item = (& $col $r 'item').ToUpperInvariant(); lot = (& $col $r 'lot'); serial = (& $col $r 'serial')
      qty = $(if ($has['qty']) { To-Num $r['qty'] } else { $null })
      from_pos = (& $col $r 'from_pos'); to_pos = (& $col $r 'to_pos'); customer = (& $col $r 'customer'); username = (& $col $r 'username')
    })
  }
  return ,$rows
}

function Upload-Moves($rows) {
  $size = 2000
  for ($i = 0; $i -lt $rows.Count; $i += $size) {
    $chunk = $rows.GetRange($i, [math]::Min($size, $rows.Count - $i)).ToArray()
    try { [void](Sb-Request 'POST' '/rest/v1/rpc/wms_moves_upsert' @{ p_rows = [object[]]$chunk }) } catch { Log ("Κινήσεις: ανέβασμα απέτυχε (" + $_ + ")"); return $false }
  }
  return $true
}

# ------------------------------------------------------------------ live
# Ένα κλείδωμα για όλα τα ανεβάσματα αποθέματος (πλήρες sync και -Live να μη μπλέκονται).
$script:Mutex = New-Object Threading.Mutex($false, 'Global\FagronWhsSync')
function Lock-Sync { try { return $script:Mutex.WaitOne(600000) } catch [Threading.AbandonedMutexException] { return $true } }
function Unlock-Sync { try { $script:Mutex.ReleaseMutex() } catch {} }

function Stock-ForItems([string[]]$codes, [string]$serialCol) {
  $p = @{}; $names = @()
  for ($i = 0; $i -lt $codes.Count; $i++) { $p["c$i"] = $codes[$i]; $names += "@c$i" }
  $ser = if ($serialCol) { ", s.[$serialCol] as serial" } else { '' }
  $q = "select p.code as position, p.Descr as area, i.code as item, i.Descr as description, s.Qty1 as qty, s.Lot as lot, s.ExpDate as expiry$ser from dbo.ms_Stock s join dbo.ms_Item i on i.ID = s.ItemId join dbo.ms_Pos p on p.ID = s.PosId where s.Qty1 > 0 and i.code in (" + ($names -join ',') + ")"
  return ,(Invoke-Sql $q $p)
}

# Τρέχει συνέχεια: κάθε LIVE_SECONDS (30) νέες κινήσεις (ID > τελευταίο) + απόθεμα
# μόνο των κωδικών που κινήθηκαν. Τερματίζει μετά από LIVE_MINUTES (0 = ποτέ).
function Run-Live {
  $secs = 5; $o = Opt 'LIVE_SECONDS'; if ($o -match '^\d+$' -and [int]$o -ge 5) { $secs = [int]$o }
  $mins = 0; $o = Opt 'LIVE_MINUTES'; if ($o -match '^\d+$') { $mins = [int]$o }
  $start = Get-Date
  Sb-Login; $loginAt = Get-Date
  # (πρώτα σε μεταβλητή: η Find-SerialColumns επιστρέφει πίνακα ως ένα αντικείμενο)
  $scAll = Find-SerialColumns
  $sc = @($scAll | Where-Object { $_.table -eq 'ms_Stock' -and $_.column -match '^[A-Za-z0-9_]+$' } | Select-Object -First 1)
  $serialCol = if ($sc.Count) { [string]$sc[0].column } else { '' }
  # αν αλλάξει το αρχείο του script, τερματίζει ώστε η προγραμματισμένη εργασία να το ξεκινήσει με τη νέα έκδοση
  $selfPath = $PSCommandPath; $selfTime = if ($selfPath) { (Get-Item $selfPath).LastWriteTimeUtc } else { $null }
  $cycle = 0
  $q = Build-MovesQuery 's.ID > @lastId'
  if (-not $q) { Fail 'Live: δεν βρέθηκε το ms_StockTrans' }
  # λίγες κάθε φορά, με τη σειρά (αν το πλήρες sync είναι πίσω, προλαβαίνει σταδιακά)
  $q = ($q -replace '^select ', 'select top 5000 ') + "`r`norder by s.ID"
  $lastId = $null
  try { $lastId = Sb-Request 'POST' '/rest/v1/rpc/wms_moves_last_id' @{} } catch {}
  if (-not $lastId) {
    $t = Invoke-Sql "select max(ID) as m from dbo.ms_StockTrans"
    $lastId = [int64]$t.Rows[0].m
    Log "Live: η εφαρμογή δεν έχει κινήσεις ακόμα -- ξεκινά από τώρα (το πλήρες sync φέρνει τις παλιές)"
  }
  $lastId = [int64]$lastId
  $lastOrd = $null
  try { $lastOrd = Sb-Request 'POST' '/rest/v1/rpc/wms_orders_last_id' @{} } catch {}
  if (-not $lastOrd) { $lastOrd = [int64](Invoke-Sql "select max(ID) as m from dbo.ms_Invoicem").Rows[0].m }
  $lastOrd = [int64]$lastOrd
  $oqs = @((Orders-Query 'm.ID > @lastOrd' 'SALEXPORTCL'), (Orders-Query 'm.ID > @lastOrd' 'SALEXPORTLS'))
  Log ("Live: ξεκίνησε (κάθε {0} δευτ., από κίνηση {1})" -f $secs, $lastId)
  while ($true) {
    try {
      if (((Get-Date) - $loginAt).TotalMinutes -gt 40) { Sb-Login; $loginAt = Get-Date }
      $t = Invoke-Sql $q @{ lastId = $lastId }
      if ($t.Rows.Count) {
        $rows = Convert-Moves $t
        if (Upload-Moves $rows) {
          $lastId = [int64](($rows | ForEach-Object { [int64]$_.id } | Measure-Object -Maximum).Maximum)
          $codes = [string[]]@($rows | ForEach-Object { $_.item } | Where-Object { $_ } | Select-Object -Unique)
          $nStock = 0
          if ($codes.Count) {
            for ($i = 0; $i -lt $codes.Count; $i += 200) {
              $part = [string[]]$codes[$i..([math]::Min($codes.Count, $i + 200) - 1)]
              $st = (Aggregate-Stock (Stock-ForItems $part $serialCol)).rows
              if (Lock-Sync) {
                try { [void](Sb-Request 'POST' '/rest/v1/rpc/wms_replace_items' @{ p_items = $part; p_stock = [object[]]@($st) }) } finally { Unlock-Sync }
              }
              $nStock += $st.Count
            }
            [void](Sb-Request 'POST' '/rest/v1/rpc/wms_signal' @{ p_key = 'stock'; p_items = $codes; p_n = $nStock })
          }
          [void](Sb-Request 'POST' '/rest/v1/rpc/wms_signal' @{ p_key = 'moves'; p_n = $rows.Count })
          Log ("Live: {0} νέες κινήσεις · απόθεμα {1} κωδικών ενημερώθηκε" -f $rows.Count, $codes.Count)
        }
      }
    } catch { Log ("Live: " + $_) }
    try {
      $orows = New-Object Collections.ArrayList
      foreach ($oq in $oqs) { foreach ($x in (Convert-Orders (Invoke-Sql $oq @{ lastOrd = $lastOrd }))) { [void]$orows.Add($x) } }
      if ($orows.Count) {
        Upload-Orders $orows
        $lastOrd = [int64](($orows | ForEach-Object { [int64]$_.order_id } | Measure-Object -Maximum).Maximum)
        [void](Sb-Request 'POST' '/rest/v1/rpc/wms_signal' @{ p_key = 'orders_sync'; p_n = $orows.Count })
        Log ("Live: {0} νέες γραμμές Orders" -f $orows.Count)
      }
    } catch { Log ("Live (Orders): " + $_) }
    try { Sync-Collecting 'SALEXPORTLS' } catch { Log ("Live (σε συλλογή): " + $_) }
    try { Refresh-Collecting 'SALEXPORTLS' } catch { Log ("Live (γραμμές σε συλλογή): " + $_) }
    # κάθε ~2 λεπτά: λίστες ανοιχτές στην εφαρμογή που ολοκληρώθηκαν στο WMS
    $cycle++
    if ($cycle % [math]::Max(1, [int](120 / $secs)) -eq 0) { try { Refresh-Completed 'SALEXPORTLS' } catch { Log ("Live (ολοκληρωμένες): " + $_) } }
    if ($selfTime -and (Test-Path $selfPath) -and (Get-Item $selfPath).LastWriteTimeUtc -ne $selfTime) { Log 'Live: νέα έκδοση script -- επανεκκίνηση'; break }
    if ($mins -gt 0 -and ((Get-Date) - $start).TotalMinutes -ge $mins) { Log 'Live: τέλος χρόνου'; break }
    Start-Sleep -Seconds $secs
  }
}

# ------------------------------------------------------------------ παραγγελίες (εύρεση)
# Μία φορά (αν λείπει το wms-orders.txt): στήλες ms_Invoicem / ms_Invoiced, πού
# υπάρχει η τιμή «salexportcl», δείγμα πρόσφατων παραστατικών. ΜΟΝΟ ανάγνωση.
function Discover-Orders {
  $out = New-Object Collections.ArrayList
  $add = { param($x) [void]$out.Add([string]$x) }
  $fmt = { param($v) if ($null -eq $v -or $v -is [DBNull]) { return $null }; if ($v -is [DateTime]) { return $v.ToString('yyyy-MM-dd HH:mm', $Inv) }; if ($v -is [double] -or $v -is [decimal]) { return ([double]$v).ToString($Inv) }; $sv = [string]$v; if ($sv.Length -gt 80) { $sv = $sv.Substring(0, 80) + '…' }; return $sv }
  $dump = { param($tbl) foreach ($r in $tbl.Rows) { $vals = foreach ($c in $tbl.Columns) { $sv = & $fmt $r[$c.ColumnName]; if ($null -ne $sv -and $sv -ne '' -and $sv -ne '0' -and $sv -ne 'False') { "$($c.ColumnName)=$sv" } }; & $add ('   · ' + ($vals -join ' | ')) } }
  $cols = Invoke-Sql @"
select c.TABLE_NAME t, c.COLUMN_NAME c, c.DATA_TYPE dt,
       (select sum(p.rows) from sys.partitions p where p.object_id = object_id('dbo.' + quotename(c.TABLE_NAME)) and p.index_id in (0, 1)) n
from INFORMATION_SCHEMA.COLUMNS c join INFORMATION_SCHEMA.TABLES t on t.TABLE_NAME = c.TABLE_NAME and t.TABLE_SCHEMA = c.TABLE_SCHEMA and t.TABLE_TYPE = 'BASE TABLE'
where c.TABLE_SCHEMA = 'dbo'
order by c.TABLE_NAME, c.ORDINAL_POSITION
"@
  $tabs = [ordered]@{}
  foreach ($r in $cols.Rows) {
    $t = [string]$r.t
    if (-not $tabs.Contains($t)) { $tabs[$t] = @{ n = $(if ($r.n -is [DBNull]) { 0 } else { [int64]$r.n }); cols = New-Object Collections.ArrayList } }
    [void]$tabs[$t].cols.Add(@{ c = [string]$r.c; dt = [string]$r.dt })
  }
  foreach ($t in 'ms_Invoicem', 'ms_Invoiced', 'ms_Person') {
    if ($tabs.Contains($t)) { & $add ''; & $add "== $t ($($tabs[$t].n) γραμμές)"; & $add ('   στήλες: ' + (($tabs[$t].cols | ForEach-Object { "$($_.c) [$($_.dt)]" }) -join ', ')) }
  }
  # πού είναι το «salexportcl»: μικροί πίνακες, όλες οι στήλες κειμένου
  & $add ''; & $add '== αναζήτηση «salexportcl»'
  $found = 0
  foreach ($t in $tabs.Keys) {
    $e = $tabs[$t]
    if ($e.n -le 0 -or $e.n -gt 20000) { continue }
    $tc = @($e.cols | Where-Object { $_.dt -match 'char|text' } | ForEach-Object { $_.c })
    if (-not $tc.Count) { continue }
    $where = ($tc | ForEach-Object { "cast([$_] as nvarchar(4000)) like N'%salexportcl%'" }) -join ' or '
    try { $rows = Invoke-Sql "select top 10 * from dbo.[$t] where $where" } catch { continue }
    if ($rows.Rows.Count) { $found++; & $add ("-- dbo.$t ($($e.n) γραμμές): " + (($e.cols | ForEach-Object { $_.c }) -join ', ')); & $dump $rows }
  }
  if (-not $found) { & $add '   (δεν βρέθηκε σε μικρούς πίνακες)' }
  # πίνακες τύπων παραστατικών
  foreach ($t in @($tabs.Keys | Where-Object { $_ -match 'InvType|InvoiceType|DocType|Spec' -and $tabs[$_].n -gt 0 -and $tabs[$_].n -lt 2000 })) {
    try { $rows = Invoke-Sql "select top 60 * from dbo.[$t]" } catch { continue }
    & $add ''; & $add "== dbo.$t ($($tabs[$t].n) γραμμές)"; & $dump $rows
  }
  # δείγμα: 3 πρόσφατα παραστατικά + γραμμές τους
  if ($tabs.Contains('ms_Invoicem')) {
    & $add ''; & $add '== πρόσφατα ms_Invoicem'
    $m = Invoke-Sql "select top 4 * from dbo.ms_Invoicem order by ID desc"
    & $dump $m
    if ($tabs.Contains('ms_Invoiced') -and $m.Rows.Count) {
      & $add ''; & $add '== γραμμές τους (ms_Invoiced)'
      $ids = ($m.Rows | ForEach-Object { [int64]$_['ID'] }) -join ','
      & $dump (Invoke-Sql "select top 12 * from dbo.ms_Invoiced where InvoicemId in ($ids)")
    }
    foreach ($k in 'InvTypeId') {
      if (@($tabs['ms_Invoicem'].cols | Where-Object { $_.c -eq $k }).Count) {
        & $add ''; & $add "== ms_Invoicem ανά $k (τελευταίες 30 ημέρες)"
        & $dump (Invoke-Sql "select $k, count(*) as n, max(ID) as last_id from dbo.ms_Invoicem where RecDate >= dateadd(day, -30, getdate()) group by $k order by n desc")
      }
    }
  }
  $report = Join-Path $Here 'wms-orders.txt'
  [IO.File]::WriteAllLines($report, [string[]]$out, (New-Object Text.UTF8Encoding $true))
  Log "Παραγγελίες: η εύρεση γράφτηκε στο wms-orders.txt"
}

# ------------------------------------------------------------------ παραγγελίες (Orders)
# Λίστες ελέγχου πωλήσεων (ms_InvType.Code = SALEXPORTCL) -> wms_orders, μία γραμμή
# ανά ms_Invoiced. Η κατάσταση Collected της εφαρμογής ΔΕΝ πειράζεται ποτέ.
function Orders-Query([string]$where, [string]$code = 'SALEXPORTCL') {
  $code = $code -replace '[^A-Za-z]', ''

  return @"
select cast(d.ID as varchar(30)) as id, cast(m.ID as varchar(30)) as order_id, cast(m.Num as varchar(30)) as list_no,
       t.Code as doc_type, m.ErpDocCode as doc_no, m.ErpKey as erp_code,
       cast(cast(m.RecDate as date) as datetime) + cast(cast(m.RecTime as time) as datetime) as order_date,
       pe.Descr as customer, pe.City1 as customer_city, pe.ZipCode as customer_zip,
       coalesce(nullif(ltrim(rtrim(pe.TaxRegNumEU)), ''), pe.TaxRegNum) as customer_vat,
       i.code as item, d.Lot as lot, d.sn as sn, d.Qty1 as qty, d.InitQty1 as init_qty,
       pf.code as from_pos, pt.code as to_pos,
       case when m.isChecked = 1 then 'checked' when m.isCompleted = 1 then 'completed' else '' end as wms_status,
       d.LineOrder as line_no,
       coalesce(nullif(ltrim(rtrim(m.zprocessedby)), ''), us.Descr) as picker,
       ltrim(rtrim(isnull(m.Comments, '') + case when ltrim(rtrim(isnull(m.Comments2, ''))) <> '' then ' · ' + ltrim(rtrim(m.Comments2)) else '' end)) as comments,
       cast(isnull(m.isNowCollecting, 0) as int) as is_collecting,
       cast(isnull(m.isCompleted, 0) as int) as is_completed, cast(isnull(m.isStrictOrderCollection, 0) as int) as is_strict
from dbo.ms_Invoicem m
join dbo.ms_InvType t on t.ID = m.InvTypeId and t.Code = '$code'
join dbo.ms_Invoiced d on d.InvoicemId = m.ID
left join dbo.ms_Item i on i.ID = d.ItemId
left join dbo.ms_Person pe on pe.ID = m.PersonId
left join dbo.ms_Pos pf on pf.ID = d.FromPosId
left join dbo.ms_Pos pt on pt.ID = d.ToPosId
left join dbo.ms_User us on us.ID = m.UserId
where $where
"@
}

# Ελλάδα ή εξωτερικό: ΑΦΜ με πρόθεμα χώρας ≠ EL/GR -> εξωτερικό· αλλιώς ΤΚ που δεν
# είναι ελληνικός (5 ψηφία, 1xx xx – 8xx xx) -> εξωτερικό· αλλιώς Ελλάδα.
function Test-Abroad([string]$vat, [string]$zip) {
  $v = ($vat -replace '[\s.\-]', '').ToUpperInvariant()
  if ($v -match '^([A-Z]{2})') { return -not ($Matches[1] -eq 'EL' -or $Matches[1] -eq 'GR') }
  $z = ($zip -replace '\s', '')
  if ($z -and $z -notmatch '^[1-8]\d{4}$') { return $true }
  return $false
}

function Convert-Orders($t) {
  $rows = New-Object Collections.ArrayList
  foreach ($r in $t.Rows) {
    $at = $r['order_date']
    $atS = if ($at -is [DateTime]) { $at.ToString('yyyy-MM-ddTHH:mm:ss', $Inv) + ([DateTimeOffset]::new($at)).ToString('zzz') } else { '' }
    [void]$rows.Add([pscustomobject][ordered]@{
      id = To-Str $r['id']; order_id = To-Str $r['order_id']; list_no = To-Str $r['list_no']; doc_type = To-Str $r['doc_type']
      doc_no = To-Str $r['doc_no']; erp_code = To-Str $r['erp_code']; order_date = $atS; customer = To-Str $r['customer']
      item = (To-Str $r['item']).ToUpperInvariant(); lot = To-Str $r['lot']; sn = To-Str $r['sn']
      qty = To-Num $r['qty']; init_qty = To-Num $r['init_qty']; from_pos = To-Str $r['from_pos']; to_pos = To-Str $r['to_pos']
      wms_status = To-Str $r['wms_status']; line_no = To-Num $r['line_no']; picker = To-Str $r['picker']
      is_completed = ((To-Num $r['is_completed']) -eq 1); is_strict = ((To-Num $r['is_strict']) -eq 1)
      customer_city = To-Str $r['customer_city']; customer_zip = To-Str $r['customer_zip']; customer_vat = To-Str $r['customer_vat']
      is_abroad = (Test-Abroad (To-Str $r['customer_vat']) (To-Str $r['customer_zip'])); comments = To-Str $r['comments']
      is_collecting = ((To-Num $r['is_collecting']) -eq 1)
    })
  }
  return ,$rows
}

function Upload-Orders($rows) {
  for ($i = 0; $i -lt $rows.Count; $i += 2000) {
    $chunk = $rows.GetRange($i, [math]::Min(2000, $rows.Count - $i)).ToArray()
    [void](Sb-Request 'POST' '/rest/v1/rpc/wms_orders_upsert' @{ p_rows = [object[]]$chunk })
  }
}

# «Σε συλλογή»: ελαφρύ query μόνο στις κεφαλίδες (κάθε κύκλο του -Live και μετά το sync)
function Sync-Collecting([string]$code = 'SALEXPORTLS') {
  $code = $code -replace '[^A-Za-z]', ''
  $t = Invoke-Sql @"
select cast(m.ID as varchar(30)) as id, coalesce(nullif(ltrim(rtrim(m.zprocessedby)), ''), us.Descr) as usr
from dbo.ms_Invoicem m
join dbo.ms_InvType t on t.ID = m.InvTypeId and t.Code = '$code'
left join dbo.ms_User us on us.ID = m.UserId
where isnull(m.isNowCollecting, 0) = 1 and isnull(m.isCompleted, 0) = 0 and m.RecDate >= dateadd(day, -365, getdate())
"@
  $ids = New-Object Collections.ArrayList; $users = @{}
  foreach ($r in $t.Rows) { $id = To-Str $r['id']; [void]$ids.Add($id); $u = To-Str $r['usr']; if ($u) { $users[$id] = $u } }
  $sig = ($ids | Sort-Object) -join ','
  # λίστες σε συλλογή τώρα + όσες μόλις τελείωσαν (για μία τελευταία ανάγνωση)
  $prev = @($script:CollectingIds)
  $script:CollectingIds = @($ids)
  $script:CollectingEnded = @($prev | Where-Object { $ids -notcontains $_ })
  if ($sig -eq $script:LastCollecting) { return }
  [void](Sb-Request 'POST' '/rest/v1/rpc/wms_orders_set_collecting' @{ p_doc_type = $code; p_ids = [string[]]$ids.ToArray(); p_users = $users })
  $script:LastCollecting = $sig
}
$script:LastCollecting = $null
$script:CollectingIds = @()
$script:CollectingEnded = @()
$script:CollectingRead = @{}

# Γραμμές των λιστών που συλλέγονται τώρα: ξαναδιαβάζονται συχνά ώστε οι ποσότητες που
# απομένουν να ενημερώνονται στην εφαρμογή σχεδόν αμέσως. Ανεβαίνουν μόνο αν άλλαξαν.
function Refresh-Collecting([string]$code = 'SALEXPORTLS') {
  $ids = @(@($script:CollectingIds) + @($script:CollectingEnded) | Where-Object { $_ -match '^\d+$' } | Select-Object -Unique)
  if (-not $ids.Count) { return }
  $t = Invoke-Sql (Orders-Query ("m.ID in (" + ($ids -join ',') + ")") $code)
  $rows = Convert-Orders $t
  $byList = @{}
  foreach ($r in $rows) { $k = [string]$r.order_id; if (-not $byList.ContainsKey($k)) { $byList[$k] = New-Object Collections.ArrayList }; [void]$byList[$k].Add($r) }
  $changed = New-Object Collections.ArrayList
  foreach ($k in $byList.Keys) {
    $sig = (@($byList[$k] | ForEach-Object { "$($_.id)=$($_.qty)/$($_.is_completed)" }) | Sort-Object) -join ';'
    if ($script:CollectingRead[$k] -ne $sig) { $script:CollectingRead[$k] = $sig; foreach ($x in $byList[$k]) { [void]$changed.Add($x) } }
  }
  if ($changed.Count) {
    Upload-Orders $changed
    [void](Sb-Request 'POST' '/rest/v1/rpc/wms_signal' @{ p_key = 'orders_sync'; p_n = $changed.Count })
  }
}

# Λίστες ανοιχτές στην εφαρμογή που στο WMS ολοκληρώθηκαν (ξαναδιαβάζονται) ή διαγράφηκαν (αφαιρούνται).
function Refresh-Completed([string]$code = 'SALEXPORTLS') {
  $open = @(Sb-Request 'POST' '/rest/v1/rpc/wms_open_lists' @{ p_doc_type = $code } | ForEach-Object { $_ } | ForEach-Object { [string]$_ } | Where-Object { $_ -match '^\d+$' })
  if (-not $open.Count) { return }
  $done = New-Object Collections.ArrayList
  $exists = @{}
  for ($i = 0; $i -lt $open.Count; $i += 500) {
    $ids = ($open[$i..([math]::Min($open.Count, $i + 500) - 1)]) -join ','
    $t = Invoke-Sql "select cast(m.ID as varchar(30)) as id, cast(isnull(m.isCompleted, 0) as int) as c from dbo.ms_Invoicem m where m.ID in ($ids)"
    foreach ($r in $t.Rows) { $id = [string]$r['id']; $exists[$id] = $true; if ([int]$r['c'] -ne 0) { [void]$done.Add($id) } }
  }
  # δεν υπάρχουν πια στο WMS -> αφαίρεση (με όριο ασφαλείας: όχι αν «λείπουν» σχεδόν όλες)
  $gone = @($open | Where-Object { -not $exists.ContainsKey($_) })
  if ($gone.Count -and $gone.Count -lt [math]::Max(20, $open.Count / 2)) {
    $n = Sb-Request 'POST' '/rest/v1/rpc/wms_orders_remove' @{ p_doc_type = $code; p_order_ids = [string[]]$gone }
    Log ("Διαγραμμένες στο WMS ($code): {0} λίστες αφαιρέθηκαν ({1} γραμμές)" -f $gone.Count, $n)
    [void](Sb-Request 'POST' '/rest/v1/rpc/wms_signal' @{ p_key = 'orders_sync'; p_n = [int]$n })
  } elseif ($gone.Count) { Log ("Διαγραμμένες στο WMS ($code): {0} -- πάρα πολλές, δεν αφαιρούνται (έλεγχος)" -f $gone.Count) }
  if (-not $done.Count) { return }
  $rows = New-Object Collections.ArrayList
  for ($i = 0; $i -lt $done.Count; $i += 300) {
    $ids = ($done[$i..([math]::Min($done.Count, $i + 300) - 1)]) -join ','
    foreach ($x in (Convert-Orders (Invoke-Sql (Orders-Query "m.ID in ($ids)" $code)))) { [void]$rows.Add($x) }
  }
  if ($rows.Count) {
    Upload-Orders $rows
    [void](Sb-Request 'POST' '/rest/v1/rpc/wms_signal' @{ p_key = 'orders_sync'; p_n = $rows.Count })
  }
  Log ("Ολοκληρωμένες στο WMS ($code): {0} λίστες ενημερώθηκαν" -f $done.Count)
}

function Sync-Orders([string]$code = 'SALEXPORTCL') {
  $last = $null
  try { $last = Sb-Request 'POST' '/rest/v1/rpc/wms_orders_last' @{ p_doc_type = $code } } catch { Log ("Orders $($code): " + $_); return }
  $days = 60; $o = Opt 'ORDERS_DAYS'; if ($o -match '^\d+$') { $days = [int]$o }
  # ξαναδιαβάζει τις τελευταίες 3 ημέρες (αλλαγές σε λίστες που ήδη υπάρχουν)
  $since = if ($last) { ([DateTime]::Parse([string]$last, $Inv)).ToLocalTime().Date.AddDays(-3) } else { (Get-Date).Date.AddDays(-$days) }
  # μία φορά: ξαναδιαβάζει όλο το διάστημα για να συμπληρωθεί ο χρήστης συλλογής
  # λάθος μελλοντική ημερομηνία στο WMS (π.χ. 18/12/2026) δεν πρέπει να «πηδάει» τις σημερινές
  if ($since -gt (Get-Date).Date) { $since = (Get-Date).Date.AddDays(-3) }
  $mark = Join-Path $Here "orders-v3-$code.done"
  if (-not (Test-Path $mark)) { $since = (Get-Date).Date.AddDays(-$days) }
  # λίστες πωλήσεων: και όλες οι ανοιχτές του τελευταίου έτους (μπορεί να είναι παλιές)
  $where = if ($code -eq 'SALEXPORTLS') { "(m.RecDate >= cast(@since as date) or (isnull(m.isCompleted, 0) = 0 and m.RecDate >= dateadd(day, -365, getdate())))" } else { 'm.RecDate >= cast(@since as date)' }
  try { $t = Invoke-Sql (Orders-Query $where $code) @{ since = $since } } catch { Log ("Orders $($code): το query απέτυχε (" + $_.Exception.Message + ")"); return }
  $rows = Convert-Orders $t
  # ανοιχτές στην εφαρμογή που δεν ήρθαν παραπάνω: ξαναδιαβάζονται (π.χ. ολοκληρώθηκαν στο WMS)
  if ($code -eq 'SALEXPORTLS') {
    try {
      $open = @(Sb-Request 'POST' '/rest/v1/rpc/wms_open_lists' @{ p_doc_type = $code } | ForEach-Object { $_ } | ForEach-Object { [string]$_ } | Where-Object { $_ -match '^\d+$' })
      $seen = @{}; foreach ($r in $rows) { $seen[$r.order_id] = $true }
      $miss = @($open | Where-Object { -not $seen.ContainsKey($_) })
      for ($i = 0; $i -lt $miss.Count; $i += 500) {
        $ids = ($miss[$i..([math]::Min($miss.Count, $i + 500) - 1)]) -join ','
        $t2 = Invoke-Sql (Orders-Query "m.ID in ($ids)" $code)
        foreach ($x in (Convert-Orders $t2)) { [void]$rows.Add($x) }
      }
    } catch { Log ("Orders $($code): ανοιχτές λίστες (" + $_ + ")") }
  }
  try { Upload-Orders $rows } catch { Log ("Orders $($code): ανέβασμα απέτυχε (" + $_ + ")"); return }
  Log ("Orders {0}: {1} γραμμές από {2:dd/MM/yyyy} και μετά." -f $code, $rows.Count, $since)
  if (-not (Test-Path $mark)) { [IO.File]::WriteAllText($mark, (Get-Date).ToString('o')) }
  if ($rows.Count) { try { [void](Sb-Request 'POST' '/rest/v1/rpc/wms_signal' @{ p_key = 'orders_sync'; p_n = $rows.Count }) } catch {} }
}

# ------------------------------------------------------------------ main
if ($Test) { Discover; exit 0 }
if ($Describe) { Describe-Tables $Describe; exit 0 }
if ($Probe) { Probe-Item $Probe $Find; exit 0 }
if ($Moves) { Discover-Moves; exit 0 }
if ($Live) { Run-Live; exit 0 }
if ($Orders) { Discover-Orders; exit 0 }

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
$finals = New-Object 'Collections.Generic.HashSet[string]'
foreach ($r in $recipes) { $pc = ([string]$r.product_code).ToUpperInvariant(); [void]$wanted.Add($pc); [void]$finals.Add($pc) }
if ($comps.Count -gt 0 -and $wanted.Count -lt 3) { Fail ("Η εφαρμογή επέστρεψε μόνο {0} κωδικούς προδιαγραφών -- κάτι δεν πάει καλά με την ανάγνωση, δεν ανεβαίνει τίποτα." -f $wanted.Count) }
$kept = [object[]]@($all | Where-Object { $wanted.Contains($_.item) })
$keptItems = @($kept | ForEach-Object { $_.item } | Select-Object -Unique).Count
Log ("Φιλτράρισμα: {0} γραμμές ({1} κωδικοί) από {2} κωδικούς προδιαγραφών · τώρα στην εφαρμογή: {3}" -f $kept.Count, $keptItems, $wanted.Count, $current.Count)

$itemInfo = Get-ItemInfo $finals
Log ("Αγγλικές περιγραφές τελικών κωδικών από το WMS: {0}" -f $itemInfo.Count)

$general = Build-General (Get-GeneralStock $result)
$withSerial = @($general.stock | Where-Object { $_.serial }).Count
Log ("Γενικές ετικέτες: {0} κωδικοί καταλόγου · {1} γραμμές αποθέματος (παρτίδα/serial) · με serial: {2}" -f $general.items.Count, $general.stock.Count, $withSerial)

if ($DryRun) {
  $general.stock | Select-Object -First 8 | Format-Table -AutoSize | Out-String -Width 200 | Write-Host
  $kept | Select-Object -First 15 | Format-Table -AutoSize | Out-String -Width 200 | Write-Host
  $itemInfo | Select-Object -First 5 | Format-Table -AutoSize | Out-String -Width 200 | Write-Host
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

if ($itemInfo.Count) {
  try {
    $n = Sb-Request 'POST' '/rest/v1/rpc/repack_update_item_info' @{ items = $itemInfo }
    Log ("Στοιχεία ετικέτας: ενημερώθηκαν {0} κωδικοί." -f $n)
  } catch { Log ("Στοιχεία ετικέτας: η ενημέρωση απέτυχε (" + $_ + ") -- το απόθεμα ανέβηκε κανονικά") }
}

if ($general.stock.Count -gt 0) {
  try {
    if (-not (Lock-Sync)) { throw 'κλείδωμα: το -Live κρατά το ανέβασμα πάνω από 10 λεπτά' }
    try { Upload-General $general } finally { Unlock-Sync }
    try { [void](Sb-Request 'POST' '/rest/v1/rpc/wms_signal' @{ p_key = 'stock_full'; p_n = $general.stock.Count }) } catch {}
    Log ("Γενικές ετικέτες: ανέβηκαν {0} γραμμές αποθέματος, {1} κωδικοί." -f $general.stock.Count, $general.items.Count)
  } catch { Log ("Γενικές ετικέτες: το ανέβασμα απέτυχε (" + $_ + ") -- η ανασυσκευασία ενημερώθηκε κανονικά") }
}

Sync-Moves
try { Backfill-Moves } catch { Log ("Κινήσεις (αναδρομικά): " + $_) }
try { Sync-ItemPack } catch { Log ("Παλέτες / συσκευασίες: " + $_) }
foreach ($oc in 'SALEXPORTCL', 'SALEXPORTLS') { try { Sync-Orders $oc } catch { Log ("Orders $($oc): " + $_) } }
try { Sync-Collecting 'SALEXPORTLS' } catch { Log ("Σε συλλογή: " + $_) }
try { Refresh-Completed 'SALEXPORTLS' } catch { Log ("Ολοκληρωμένες / διαγραμμένες: " + $_) }

if (-not (Test-Path (Join-Path $Here 'wms-orders.txt'))) { try { Discover-Orders } catch { Log ("Παραγγελίες (εύρεση): " + $_) } }
