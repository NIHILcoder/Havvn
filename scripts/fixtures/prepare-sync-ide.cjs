/* eslint-disable @typescript-eslint/no-require-imports -- Isolated acceptance data. */
const fs = require('node:fs'), path = require('node:path');
const fixture = require('./room-sync-office-session.cjs');
const root = fixture.prepare('ide');
const files = {
  'Project/Program.cs': 'using System;\nclass Program { static void Main() { Console.WriteLine("HAVVN_IDE_V1"); } }\n',
  'Project/Pilot.csproj': '<Project ToolsVersion="4.0" DefaultTargets="Build" xmlns="http://schemas.microsoft.com/developer/msbuild/2003">\n<PropertyGroup><OutputType>Exe</OutputType><TargetFrameworkVersion>v4.0</TargetFrameworkVersion><AssemblyName>HavvnSyncPilot</AssemblyName><OutputPath>bin\\Debug\\</OutputPath></PropertyGroup>\n<ItemGroup><Reference Include="System" /><Compile Include="Program.cs" /></ItemGroup>\n<Import Project="$(MSBuildToolsPath)\\Microsoft.CSharp.targets" />\n</Project>\n',
  'Project/Pilot.sln': 'Microsoft Visual Studio Solution File, Format Version 12.00\n# Visual Studio Version 17\nProject("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "Pilot", "Pilot.csproj", "{23195704-53F9-4EE8-9E0A-5F0A9B8B69E7}"\nEndProject\nGlobal\nEndGlobal\n',
  'config.ini': '[sync]\nrevision=1\n',
  'README.md': '# Проверка проекта в IDE\nИсходники общие, результаты сборки остаются локально.\n',
  'Project/obj/ignored.txt': 'test build cache\n',
  'Project/.vs/local.txt': 'test IDE state\n',
  'Project/bin/ignored.txt': 'test build output\n',
  '.git/local.txt': 'test repository state\n',
  '.env': 'SYNTHETIC_FIXTURE=not-a-secret\n',
};
for (const [name, body] of Object.entries(files)) {
  const target = path.join(root, 'publisher/working', name);
  fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, body, { flag: 'wx' });
}
console.log(root);
