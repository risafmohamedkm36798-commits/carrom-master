const fs = require('fs');
const { spawnSync } = require('child_process');

const htmlPath = 'c:/Users/Asus/Downloads/carromm/server/ccpvp.html';
const content = fs.readFileSync(htmlPath, 'utf8');

const scripts = content.match(/<script>([\s\S]*?)<\/script>/g);
if (!scripts) {
    console.log('No scripts found');
    process.exit(0);
}

scripts.forEach((scriptTag, index) => {
    const code = scriptTag.replace(/<script>|<\/script>/g, '');
    const tmpFile = `c:/Users/Asus/Downloads/carromm/server/tmp_script_${index}.js`;
    fs.writeFileSync(tmpFile, code);
    console.log(`Checking script ${index}...`);
    const result = spawnSync('node', ['-c', tmpFile]);
    if (result.status !== 0) {
        console.error(`Syntax error in script ${index}:`);
        console.error(result.stderr.toString());
    } else {
        console.log(`Script ${index} is valid`);
    }
    fs.unlinkSync(tmpFile);
});
