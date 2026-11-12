// What a new machine is given so it installs itself: cloud-init for cloud images, the Omarchy ISO's
// unattended-install files, and a Windows Setup answer file. Pure functions, so they're easy to test.
import {randomUUID} from 'node:crypto'

export const hostnameFor = (name, id) => name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63) || `machine-${id}`

// cloud-init user-data. `hash` is a SHA-512 crypt hash; the password itself is never written.
export function cloudUserData({host, username, hash, cloudInit = {}}) {
	const lines = [
		'#cloud-config',
		`hostname: ${host}`,
		'users:',
		`  - name: ${username}`,
		`    groups: [${cloudInit.adminGroup === 'wheel' ? 'wheel' : 'sudo'}]`,
		"    sudo: 'ALL=(ALL) ALL'",
		`    shell: ${cloudInit.shell ?? '/bin/bash'}`,
		'    lock_passwd: false',
		`    passwd: '${hash}'`,
		'ssh_pwauth: true',
	]
	const packages = Array.isArray(cloudInit.packages) ? cloudInit.packages.filter((p) => /^@?[A-Za-z0-9][\w.+-]*$/.test(p)) : []
	if (packages.length) lines.push('package_update: true', 'packages:', ...packages.map((p) => `  - '${p}'`))
	// Extra setup commands from the catalog, as argument lists (no shell).
	const commands = (cloudInit.commands ?? []).filter((c) => Array.isArray(c) && c.length && c.every((a) => typeof a === 'string'))
	if (commands.length) lines.push('runcmd:', ...commands.map((c) => `  - ${JSON.stringify(c)}`))
	// A desktop comes up after one restart, once its packages are in.
	if (cloudInit.graphical) lines.push('power_state:', '  mode: reboot', '  message: Desktop installed, restarting', '  condition: true')
	return `${lines.join('\n')}\n`
}
export const cloudMetaData = (host) => `instance-id: ${randomUUID()}\nlocal-hostname: ${host}\n`

// The Omarchy ISO installs by itself when it finds a drive labelled "cidata" holding these two files
// (archinstall's own configuration format). Disk: the machine's only disk, /dev/vda.
export function omarchyConfiguration({host, diskSizeGb, timezone = 'UTC'}) {
	const MiB = 1024 ** 2
	const boot = 2 * 1024 ** 3
	const size = (value) => ({unit: 'B', value, sector_size: {unit: 'B', value: 512}})
	return {
		bootloader_config: {bootloader: 'Limine', uki: false, removable: false},
		audio_config: {audio: 'pipewire'},
		disk_config: {
			config_type: 'default_layout',
			device_modifications: [
				{
					device: '/dev/vda',
					wipe: true,
					partitions: [
						{obj_id: randomUUID(), status: 'create', type: 'primary', fs_type: 'fat32', dev_path: null, mount_options: [], mountpoint: '/boot', flags: ['boot', 'esp'], start: size(MiB), size: size(boot)},
						{
							obj_id: randomUUID(),
							status: 'create',
							type: 'primary',
							fs_type: 'btrfs',
							dev_path: null,
							mountpoint: null,
							mount_options: ['compress=zstd'],
							flags: [],
							btrfs: [
								{name: '@', mountpoint: '/'},
								{name: '@home', mountpoint: '/home'},
								{name: '@log', mountpoint: '/var/log'},
								{name: '@pkg', mountpoint: '/var/cache/pacman/pkg'},
							],
							start: size(MiB + boot),
							size: size(diskSizeGb * 1024 ** 3 - boot - 2 * MiB),
						},
					],
				},
			],
		},
		hostname: host,
		network_config: {type: 'iso'},
		ntp: true,
		swap: true,
		timezone,
		locale_config: {kb_layout: 'us', sys_enc: 'UTF-8', sys_lang: 'en_US.UTF-8'},
	}
}
export const omarchyCredentials = ({username, hash}) => ({users: [{username, enc_password: hash, sudo: true}]})

// Windows 10/11 retail ISOs carry volume labels like CCCOMA_X64FRE_EN-US_DV9.
export const isWindowsClientLabel = (label) => /^CCCOMA_X64FRE/i.test(label ?? '')
export const isWindowsLabel = (label) => /^(CCCOMA_|CPBA_|CCSA_|SSS_|CENA_|J?CPRA_|GRMC|GSP1|IR\d_|HRM_|HB1_)/i.test(label ?? '') || /win/i.test(label ?? '')

// Microsoft's published generic key for installing Windows 10/11 Pro (it installs, it doesn't
// activate). Enter your own key in Windows Settings → Activation afterwards.
export const WINDOWS_PRO_SETUP_KEY = 'W269N-WFGWX-YVC9B-4J6C9-T83GX'
const xmlText = (s) => String(s).replace(/[<>&'"]/g, (c) => ({'<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;'})[c])
// Windows' own (reversible) encoding for answer-file passwords: base64 of UTF-16LE(password + "Password").
const windowsPassword = (pw) => Buffer.from(`${pw}Password`, 'utf16le').toString('base64')

// Answer file for Windows 10/11 x64 on UEFI: wipes the machine's one disk, skips the TPM/Secure Boot/
// RAM checks (the VM has neither TPM nor Secure Boot), creates a local administrator, and skips the
// online-account and privacy screens.
export function windowsAnswerFile({computerName, username, password, productKey = WINDOWS_PRO_SETUP_KEY}) {
	const c = (name) => `<component name="${name}" processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS">`
	const reg = (order, key, value) =>
		`<RunSynchronousCommand wcm:action="add"><Order>${order}</Order><Path>reg add ${key} /v ${value} /t REG_DWORD /d 1 /f</Path></RunSynchronousCommand>`
	const name = computerName.replace(/[^A-Za-z0-9-]/g, '').slice(0, 15) || 'OMARCHY-WIN'
	return `<?xml version="1.0" encoding="utf-8"?>
<unattend xmlns="urn:schemas-microsoft-com:unattend" xmlns:wcm="http://schemas.microsoft.com/WMIConfig/2002/State">
  <settings pass="windowsPE">
    ${c('Microsoft-Windows-International-Core-WinPE')}
      <SetupUILanguage><UILanguage>en-US</UILanguage></SetupUILanguage>
      <InputLocale>en-US</InputLocale><SystemLocale>en-US</SystemLocale><UILanguage>en-US</UILanguage><UserLocale>en-US</UserLocale>
    </component>
    ${c('Microsoft-Windows-Setup')}
      <RunSynchronous>
        ${reg(1, 'HKLM\\SYSTEM\\Setup\\LabConfig', 'BypassTPMCheck')}
        ${reg(2, 'HKLM\\SYSTEM\\Setup\\LabConfig', 'BypassSecureBootCheck')}
        ${reg(3, 'HKLM\\SYSTEM\\Setup\\LabConfig', 'BypassRAMCheck')}
      </RunSynchronous>
      <DiskConfiguration>
        <Disk wcm:action="add">
          <DiskID>0</DiskID>
          <WillWipeDisk>true</WillWipeDisk>
          <CreatePartitions>
            <CreatePartition wcm:action="add"><Order>1</Order><Type>EFI</Type><Size>300</Size></CreatePartition>
            <CreatePartition wcm:action="add"><Order>2</Order><Type>MSR</Type><Size>16</Size></CreatePartition>
            <CreatePartition wcm:action="add"><Order>3</Order><Type>Primary</Type><Extend>true</Extend></CreatePartition>
          </CreatePartitions>
          <ModifyPartitions>
            <ModifyPartition wcm:action="add"><Order>1</Order><PartitionID>1</PartitionID><Format>FAT32</Format><Label>System</Label></ModifyPartition>
            <ModifyPartition wcm:action="add"><Order>2</Order><PartitionID>2</PartitionID></ModifyPartition>
            <ModifyPartition wcm:action="add"><Order>3</Order><PartitionID>3</PartitionID><Format>NTFS</Format><Label>Windows</Label><Letter>C</Letter></ModifyPartition>
          </ModifyPartitions>
        </Disk>
      </DiskConfiguration>
      <ImageInstall><OSImage><InstallTo><DiskID>0</DiskID><PartitionID>3</PartitionID></InstallTo></OSImage></ImageInstall>
      <UserData>
        <AcceptEula>true</AcceptEula>
        <ProductKey><Key>${xmlText(productKey)}</Key><WillShowUI>OnError</WillShowUI></ProductKey>
      </UserData>
    </component>
  </settings>
  <settings pass="specialize">
    ${c('Microsoft-Windows-Shell-Setup')}
      <ComputerName>${xmlText(name)}</ComputerName>
    </component>
    ${c('Microsoft-Windows-Deployment')}
      <RunSynchronous>
        <RunSynchronousCommand wcm:action="add"><Order>1</Order><Path>reg add HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\OOBE /v BypassNRO /t REG_DWORD /d 1 /f</Path></RunSynchronousCommand>
      </RunSynchronous>
    </component>
  </settings>
  <settings pass="oobeSystem">
    ${c('Microsoft-Windows-Shell-Setup')}
      <OOBE>
        <HideEULAPage>true</HideEULAPage>
        <HideOnlineAccountScreens>true</HideOnlineAccountScreens>
        <HideWirelessSetupInOOBE>true</HideWirelessSetupInOOBE>
        <HideOEMRegistrationScreen>true</HideOEMRegistrationScreen>
        <ProtectYourPC>3</ProtectYourPC>
      </OOBE>
      <UserAccounts>
        <LocalAccounts>
          <LocalAccount wcm:action="add">
            <Name>${xmlText(username)}</Name>
            <DisplayName>${xmlText(username)}</DisplayName>
            <Group>Administrators</Group>
            <Password><Value>${windowsPassword(password)}</Value><PlainText>false</PlainText></Password>
          </LocalAccount>
        </LocalAccounts>
      </UserAccounts>
    </component>
  </settings>
</unattend>
`
}
