<#
.SYNOPSIS
    Black-box acceptance driver for the composed ShopFlow stack (owner: shopflow-infra).

.DESCRIPTION
    1. docker compose down -v --remove-orphans   fresh volumes -> reproducible seed state
    2. docker compose up -d --build
    3. wait until db, notification-provider, api and web report healthy
    4. phase 1: behavior-preservation (requirements 1-9) + concurrency invariant
    5. restart durability: prepare -> `docker compose restart api` -> verify
    6. provider outage: stop -> pending -> start -> recovered
    7. pass/fail summary and a non-zero exit code on any failure

    The stack is left running with its volumes intact, so a failure can be inspected; use -Down to
    finish with `docker compose down` (never `-v`) when you do not need the state.

.EXAMPLE
    .\run-acceptance.ps1
    .\run-acceptance.ps1 -Down
#>
[CmdletBinding()]
param(
    [switch]$Down
)

$ErrorActionPreference = 'Continue'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
Push-Location $scriptDir

$healthTimeout = if ($env:API_HEALTH_TIMEOUT) { [int]$env:API_HEALTH_TIMEOUT } else { 300 }
$relayMs = if ($env:OUTBOX_RELAY_INTERVAL_MS) { $env:OUTBOX_RELAY_INTERVAL_MS } else { '10000' }
$orderTag = if ($env:DURABILITY_ORDER_TAG) {
    $env:DURABILITY_ORDER_TAG
}
else {
    [string][int][double]::Parse((Get-Date -UFormat %s))
}
$baseUrl = if ($env:ACCEPTANCE_BASE_URL) { $env:ACCEPTANCE_BASE_URL } else { 'http://web' }

$summary = New-Object System.Collections.ArrayList
$script:failures = 0

function Add-Result {
    param([int]$Code, [string]$Label)
    if ($Code -eq 0) {
        [void]$script:summary.Add([pscustomobject]@{ Label = $Label; Status = 'PASS' })
    }
    else {
        $script:failures += 1
        [void]$script:summary.Add([pscustomobject]@{ Label = $Label; Status = "FAIL (exit $Code)" })
    }
}

function Show-Summary {
    Write-Host ''
    Write-Host '======================== acceptance summary ========================'
    foreach ($entry in $script:summary) {
        Write-Host ('{0,-56} {1}' -f $entry.Label, $entry.Status)
    }
    Write-Host '===================================================================='
    if ($script:failures -eq 0) {
        Write-Host 'RESULT: PASS - every acceptance phase is green'
    }
    else {
        Write-Host ("RESULT: FAIL - {0} phase(s) failed" -f $script:failures)
    }
    Write-Host ''
}

function Stop-WithFailure {
    Show-Summary
    Write-Host 'The stack and its volumes were kept for inspection.'
    Write-Host 'Reset with: docker compose down -v --remove-orphans'
    Pop-Location
    exit 1
}

function Get-ContainerHealth {
    param([string]$Service)
    $containerId = & docker compose ps -q $Service 2>$null
    if (-not $containerId) {
        return 'missing'
    }
    $health = & docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' $containerId 2>$null
    if (-not $health) {
        return 'unknown'
    }
    return ($health | Select-Object -First 1)
}

function Wait-Healthy {
    param([string]$Service, [int]$TimeoutSeconds)
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    Write-Host ("  waiting for {0} to report healthy" -f $Service) -NoNewline
    while ($true) {
        $status = Get-ContainerHealth -Service $Service
        if ($status -eq 'healthy') {
            Write-Host ' ok'
            return $true
        }
        if ((Get-Date) -ge $deadline) {
            Write-Host (" timed out (last status: {0})" -f $status)
            return $false
        }
        Write-Host '.' -NoNewline
        Start-Sleep -Seconds 2
    }
}

function Invoke-TestPhase {
    param([string]$Label, [string]$Phase, [string[]]$Files)
    Write-Host ''
    Write-Host ("--- {0}" -f $Label)
    $arguments = @(
        'compose', 'run', '--rm', '--no-deps',
        '-e', "BASE_URL=$baseUrl",
        '-e', "DURABILITY_ORDER_TAG=$orderTag",
        '-e', "OUTBOX_RELAY_INTERVAL_MS=$relayMs"
    )
    if ($Phase) {
        $arguments += @('-e', "DURABILITY_PHASE=$Phase")
    }
    $arguments += @('acceptance', 'node', '--test', '--test-concurrency=1')
    $arguments += $Files
    & docker @arguments
    return $LASTEXITCODE
}

Write-Host ("=== shopflow acceptance run (tag {0}, origin {1}) ===" -f $orderTag, $baseUrl)

Write-Host ''
Write-Host '--- reset: docker compose down -v --remove-orphans'
& docker compose down -v --remove-orphans | Out-Null

Write-Host '--- start: docker compose up -d --build'
& docker compose up -d --build
Add-Result -Code $LASTEXITCODE -Label 'startup: docker compose up -d --build'
if ($script:failures -ne 0) { Stop-WithFailure }

Write-Host ''
Write-Host '--- health: db, notification-provider, api, web'
foreach ($service in @('db', 'notification-provider', 'api', 'web')) {
    if (-not (Wait-Healthy -Service $service -TimeoutSeconds $healthTimeout)) {
        Add-Result -Code 1 -Label "health: $service"
        Stop-WithFailure
    }
}
Add-Result -Code 0 -Label 'health: db, notification-provider, api, web healthy'

$phaseOneStatus = Invoke-TestPhase -Label 'phase 1: preserved behaviour (requirements 1-9) and the concurrency invariant' -Phase '' -Files @('tests/behavior-preservation.test.mjs', 'tests/concurrency.test.mjs')
Add-Result -Code $phaseOneStatus -Label 'phase 1: behavior-preservation + concurrency'
if ($phaseOneStatus -ne 0) { Stop-WithFailure }

$prepareStatus = Invoke-TestPhase -Label 'durability prepare: order created before the api restart' -Phase 'prepare' -Files @('tests/restart-durability.test.mjs')
Add-Result -Code $prepareStatus -Label 'durability: prepare (pre-restart order)'
if ($prepareStatus -ne 0) { Stop-WithFailure }

Write-Host ''
Write-Host '--- restart api: docker compose restart api'
& docker compose restart api
Add-Result -Code $LASTEXITCODE -Label 'infrastructure: docker compose restart api'
if ($script:failures -ne 0) { Stop-WithFailure }

if (-not (Wait-Healthy -Service 'api' -TimeoutSeconds $healthTimeout)) {
    Add-Result -Code 1 -Label 'health: api after restart'
    Stop-WithFailure
}
Add-Result -Code 0 -Label 'health: api healthy after restart'

$verifyStatus = Invoke-TestPhase -Label 'durability verify: post-restart durability and no duplicated notifications' -Phase 'verify' -Files @('tests/restart-durability.test.mjs')
Add-Result -Code $verifyStatus -Label 'durability: verify (post-restart durability)'
if ($verifyStatus -ne 0) { Stop-WithFailure }

Write-Host ''
Write-Host '--- fault injection: docker compose stop notification-provider'
& docker compose stop notification-provider
Add-Result -Code $LASTEXITCODE -Label 'infrastructure: notification-provider stopped'
if ($script:failures -ne 0) { Stop-WithFailure }

$pendingStatus = Invoke-TestPhase -Label 'durability pending: order committed while the provider is unreachable' -Phase 'pending' -Files @('tests/restart-durability.test.mjs')
Add-Result -Code $pendingStatus -Label 'durability: pending (post-commit failure path)'
if ($pendingStatus -ne 0) { Stop-WithFailure }

Write-Host ''
Write-Host '--- recovery: docker compose start notification-provider'
& docker compose start notification-provider
Add-Result -Code $LASTEXITCODE -Label 'infrastructure: notification-provider started'
if ($script:failures -ne 0) { Stop-WithFailure }

if (-not (Wait-Healthy -Service 'notification-provider' -TimeoutSeconds $healthTimeout)) {
    Add-Result -Code 1 -Label 'health: notification-provider after restart'
    Stop-WithFailure
}
Add-Result -Code 0 -Label 'health: notification-provider healthy again'

$recoveredStatus = Invoke-TestPhase -Label 'durability recovered: the relay delivers the pending intent exactly once' -Phase 'recovered' -Files @('tests/restart-durability.test.mjs')
Add-Result -Code $recoveredStatus -Label 'durability: recovered (relay delivers exactly once)'
if ($recoveredStatus -ne 0) { Stop-WithFailure }

Show-Summary

if ($Down) {
    Write-Host '--- shutdown: docker compose down --remove-orphans'
    & docker compose down --remove-orphans
}

Write-Host 'Inspect the stack at: docker compose ps / http://127.0.0.1:3000'
Write-Host 'Full cleanup: docker compose down -v --remove-orphans'
Pop-Location
exit 0
