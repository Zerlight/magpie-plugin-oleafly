$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$stage = $env:MAGPIE_OLEAFLY_STAGE
$item = Get-Item -LiteralPath $stage -Force
if (!$item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw 'Invalid staging directory'
}
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = Get-Acl -LiteralPath $stage
$owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
if ($owner -ne $sid.Value -and $owner -ne 'S-1-5-32-544') { throw 'Unexpected staging directory owner' }

# Protect staged MCP credentials even when a profile has custom inherited permissions.
$permissions = 'D:P' + ((@($sid.Value, 'S-1-5-18', 'S-1-5-32-544') | Select-Object -Unique |
    ForEach-Object { "(A;OICI;FA;;;$_)" }) -join '')
$expected = New-Object Security.AccessControl.DirectorySecurity
$access = [Security.AccessControl.AccessControlSections]::Access
$expected.SetSecurityDescriptorSddlForm($permissions, $access)
if ($acl.GetSecurityDescriptorSddlForm($access) -ne $expected.GetSecurityDescriptorSddlForm($access)) {
    [IO.Directory]::SetAccessControl($stage, $expected)
}

$parent = Get-Process -Id $env:MAGPIE_OLEAFLY_PARENT -ErrorAction SilentlyContinue
@{ parent = $parent.Path } | ConvertTo-Json -Compress
