param(
    [switch]$BuildInstaller
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$project = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$runtime = Join-Path $project '.runtime'
$cache = Join-Path $runtime 'downloads'
$pythonHome = Join-Path $runtime 'python'
$pythonExe = Join-Path $pythonHome 'python.exe'
$nodeHome = Join-Path $runtime 'node'
$nodeExe = Join-Path $nodeHome 'node.exe'
$npmCmd = Join-Path $nodeHome 'npm.cmd'
$nodeVersion = '22.16.0'
$pythonVersion = '3.12.10'

function Step([string]$message) {
    Write-Host ''
    Write-Host ('[ACL] ' + $message) -ForegroundColor Cyan
}

function Assert-Success([string]$step) {
    if ($LASTEXITCODE -ne 0) {
        throw "$step завершился с кодом $LASTEXITCODE"
    }
}

function Download-File([string]$uri, [string]$destination) {
    if (Test-Path -LiteralPath $destination) { return }
    $temporary = $destination + '.part'
    for ($attempt = 1; $attempt -le 3; $attempt++) {
        try {
            Step "Загрузка ($attempt/3): $uri"
            Invoke-WebRequest -Uri $uri -OutFile $temporary -TimeoutSec 900 -MaximumRedirection 5
            if ((Get-Item -LiteralPath $temporary).Length -lt 1048576) {
                throw "Файл слишком маленький: $uri"
            }
            Move-Item -LiteralPath $temporary -Destination $destination -Force
            return
        } catch {
            Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
            if ($attempt -eq 3) { throw }
            Start-Sleep -Seconds 3
        }
    }
}

function Ensure-Node {
    if (Test-Path -LiteralPath $nodeExe) { return }

    # Existing Node.js 22+ can be reused, but is not required.
    $existing = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($existing) {
        $version = (& $existing.Source -v 2>$null)
        if ($version -match '^v(\d+)\.' -and [int]$Matches[1] -ge 22) {
            Step "Используется установленный Node.js $version"
            return
        }
    }

    $archive = Join-Path $cache ('node-v' + $nodeVersion + '-win-x64.zip')
    $url = 'https://nodejs.org/dist/v' + $nodeVersion + '/node-v' + $nodeVersion + '-win-x64.zip'
    Download-File $url $archive
    Step 'Распаковка локального Node.js (без установки в систему)'
    $unpack = Join-Path $runtime ('node-extract-' + [Guid]::NewGuid().ToString('N'))
    try {
        Expand-Archive -LiteralPath $archive -DestinationPath $unpack -Force
        $source = Join-Path $unpack ('node-v' + $nodeVersion + '-win-x64')
        if (-not (Test-Path -LiteralPath (Join-Path $source 'node.exe'))) {
            throw 'В архиве Node.js отсутствует node.exe'
        }
        if (Test-Path -LiteralPath $nodeHome) {
            Remove-Item -LiteralPath $nodeHome -Recurse -Force
        }
        Move-Item -LiteralPath $source -Destination $nodeHome
    } finally {
        Remove-Item -LiteralPath $unpack -Recurse -Force -ErrorAction SilentlyContinue
    }
}

function Ensure-Python {
    if (Test-Path -LiteralPath $pythonExe) { return }

    $installer = Join-Path $cache ('python-' + $pythonVersion + '-amd64.exe')
    $url = 'https://www.python.org/ftp/python/' + $pythonVersion + '/python-' + $pythonVersion + '-amd64.exe'
    Download-File $url $installer
    Step 'Установка Python 3.12 в локальную папку (права администратора не нужны)'
    $arguments = @(
        '/quiet', 'InstallAllUsers=0', 'Include_pip=1', 'Include_launcher=0',
        'Include_tcltk=0', 'Include_test=0', 'Include_doc=0',
        'AssociateFiles=0', 'PrependPath=0', 'Shortcuts=0',
        ('TargetDir="' + $pythonHome + '"')
    )
    $process = Start-Process -FilePath $installer -ArgumentList $arguments -Wait -PassThru
    if ($process.ExitCode -ne 0) {
        throw "Не удалось установить Python, код: $($process.ExitCode)"
    }
    if (-not (Test-Path -LiteralPath $pythonExe)) {
        throw "Python не найден после установки: $pythonExe"
    }
}

function Run-Project {
    Push-Location (Join-Path $project 'desktop')
    try {
        $lockPath = Join-Path (Get-Location) 'package-lock.json'
        $dependencies = Join-Path (Get-Location) 'node_modules'
        $stamp = Join-Path $dependencies '.acl-package-lock.sha256'
        $hash = (Get-FileHash -LiteralPath $lockPath -Algorithm SHA256).Hash
        $installed = (Test-Path -LiteralPath (Join-Path $dependencies 'electron')) -and
            (Test-Path -LiteralPath $stamp) -and
            ((Get-Content -LiteralPath $stamp -Raw).Trim() -eq $hash)
        if (-not $installed) {
            Step 'Установка зависимостей React/Electron через npm ci'
            & npm.cmd ci --no-audit --no-fund
            Assert-Success 'npm ci'
            Set-Content -LiteralPath $stamp -Value $hash -NoNewline
        } else {
            Step 'Зависимости npm уже установлены'
        }
        if ($BuildInstaller) {
            Step 'Production-сборка и создание Windows-установщика'
            & npm.cmd run package:win
            Assert-Success 'npm run package:win'
        } else {
            Step 'Запуск Anime Audio Cleaner'
            & npm.cmd run dev
            Assert-Success 'npm run dev'
        }
    } finally {
        Pop-Location
    }
}

try {
    if ($env:OS -ne 'Windows_NT') {
        throw 'Автоматическая установка пока поддерживает Windows 10/11.'
    }
    New-Item -ItemType Directory -Path $runtime, $cache -Force | Out-Null
    Ensure-Node
    Ensure-Python

    # Local tools are private to this checkout, never change system PATH.
    if (Test-Path -LiteralPath $nodeExe) {
        $env:PATH = $nodeHome + ';' + $env:PATH
    }
    $env:PYTHONUTF8 = '1'
    $env:PYTHONIOENCODING = 'utf-8'
    $env:PYTHONUNBUFFERED = '1'

    Push-Location $project
    try {
        Step 'Проверка и автоматическая загрузка FFmpeg и FFprobe'
        & $pythonExe -c 'from bootstrap import install_ffmpeg; install_ffmpeg()'
        Assert-Success 'FFmpeg'
        if (-not $BuildInstaller) {
            $venv = Join-Path $project '.venv\Scripts\python.exe'
            $ready = Join-Path $project '.ready.json'
            $mainModel = Join-Path $project 'models\melband_roformer_inst_v1e_plus.ckpt'
            $secondModel = Join-Path $project 'models\mel_band_roformer_instrumental_becruily.ckpt'
            if (-not ((Test-Path -LiteralPath $venv) -and
                (Test-Path -LiteralPath $ready) -and
                (Test-Path -LiteralPath $mainModel) -and
                (Test-Path -LiteralPath $secondModel))) {
                Step 'Настройка Python, PyTorch и нейросетевых моделей'
                & $pythonExe -u bootstrap.py
                Assert-Success 'Python и модели'
            } else {
                Step 'Нейросетевой обработчик уже подготовлен'
            }
        }
    } finally {
        Pop-Location
    }

    Run-Project
    if ($BuildInstaller) {
        Step ('Установщик готов: ' + (Join-Path $project 'dist-installers'))
    }
} catch {
    Write-Host ''
    Write-Host ('[ACL] Ошибка: ' + $_.Exception.Message) -ForegroundColor Red
    Write-Host 'Проверьте подключение к интернету и свободное место. Повторный запуск безопасен.' -ForegroundColor Yellow
    exit 1
}