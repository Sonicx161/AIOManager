// Prints a Dashboard password hash for ADMIN_SECRET_HASH. Reads the password from a
// hidden prompt, or from stdin when piped, so it never lands in shell history or env.
//   npm --prefix server run admin:hash
import readline from 'node:readline'
import { hashAdminPassphrase, passphraseProblem } from '../admin/passphrase.js'

function promptHidden(question) {
    return new Promise((resolve) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: true })
        rl._writeToOutput = (s) => { if (s.startsWith(question)) process.stderr.write(question) }
        rl.question(question, (answer) => { rl.close(); process.stderr.write('\n'); resolve(answer) })
    })
}

async function readPiped() {
    let data = ''
    for await (const chunk of process.stdin) data += chunk
    return data.split(/\r?\n/)[0]
}

let passphrase
if (process.stdin.isTTY) {
    passphrase = await promptHidden('Dashboard password: ')
    const again = await promptHidden('Repeat password: ')
    if (again !== passphrase) {
        process.stderr.write('Passwords do not match.\n')
        process.exit(1)
    }
} else {
    passphrase = await readPiped()
}

const problem = passphraseProblem(passphrase)
if (problem) {
    process.stderr.write(`${problem}.\n`)
    process.exit(1)
}
const hash = await hashAdminPassphrase(passphrase)
process.stdout.write(`${hash}\n`)
process.stderr.write('Set this as ADMIN_SECRET_HASH, your sign-in name as ADMIN_USERNAME (defaults to admin), set ADMIN_ENABLED=true and restart the server.\n')
