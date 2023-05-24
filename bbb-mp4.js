const puppeteer = require('puppeteer');
const child_process = require('child_process');
const Xvfb = require('xvfb');
const fs = require("fs");
const {randomUUID} = require('crypto');


// ----------- Video settings -----------
const width = 1920;
const height = 1080;

// to avoid annoying chrome "automated testing" info bar. ~60px at 1920x1080
const chromeInfoBarHeight = 60;

// to avoid dark line at the left of screen. ~60px at 1920x1080
const leftDarkLineWidth = 10;

// ---------- Execution settings ----------
const allowParallelRecordingsRun = false;
const recordingsFolder = '/usr/src/app/download/';

// Generate random display port number to avoid xvfb failure
const disp_num = Math.floor(Math.random() * (200 - 99) + 99);
const xvfb = new Xvfb({
    displayNum: disp_num,
    silent: true,
    xvfb_args: ["-screen", "0", `${width + leftDarkLineWidth}x${height + chromeInfoBarHeight}x24`, "-ac", "-nolisten", "tcp", "-dpi", "192", "+extension", "RANDR"]
});
const options = {
    headless: false,
    args: [
        '--disable-infobars',
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--start-fullscreen',
        '--app=https://www.google.com/',
        `--window-size=${width},${height + chromeInfoBarHeight}`,
    ],
};
options.executablePath = "/usr/bin/google-chrome"

let exportName;
let logFileStream;

console.log = logFunction;
console.error = logFunction;

async function main() {
    let tempLogFilename = initLog();
    let browser, page;

    try {
        if (!allowParallelRecordingsRun) {
            console.log("Waiting others recordings to finish");
            await sleepUtilNoOtherRecordingsRun();
        }

        xvfb.startSync()

        const url = process.argv[2];
        if (!url) {
            console.warn('URL undefined!');
            process.exit(1);
        }

        // Validate URL 
        const urlRegex = new RegExp('^https?:\\/\\/.*\\/playback\\/presentation\\/2\\.3\\/[a-z0-9]{40}-[0-9]{13}');
        if (!urlRegex.test(url)) {
            console.warn('Invalid recording URL for bbb 2.3!');
            console.warn(url)
            process.exit(1);
        }

        // Set exportName
        exportName = new URL(url).pathname.split("/")[4];

        fs.renameSync(recordingsFolder + tempLogFilename, recordingsFolder + exportName + '.start');
        logStart(exportName);

        // set duration to 0
        let duration = 0;

        browser = await puppeteer.launch(options)
        const pages = await browser.pages()
        page = pages[0]

        page.on('console', msg => {
            console.log('PAGE LOG:', msg.text()) // uncomment if you need
        });

        // Wait for duration on page
        await page.waitForTimeout(20 * 1000)

        await page._client.send('Emulation.clearDeviceMetricsOverride')

        // Catch URL unreachable error
        await page.goto(url, {waitUntil: 'networkidle2'}).catch(e => {
            console.error('Recording URL unreachable!');
            process.exit(2);
        })
        await page.setBypassCSP(true)

        // Check if recording exists (search "404" message)
        await page.waitForTimeout(20 * 1000)

        try {
            const loadMsg = await page.$eval('.error-code', el => el.textContent);
            console.log(loadMsg)
            if (loadMsg == "404") {
                console.warn("Recording not found!");
                process.exit(1);
            }
        } catch (err) {
            console.log("Recording found")
        }

        // Wait for duration on page
        await page.waitForTimeout(20 * 1000)
        // Get recording duration
        duration = await page.evaluate(() => {
            return document.getElementById("vjs_video_3_html5_api").duration
        });
        console.log(duration)

        await page.waitForSelector('button[class=vjs-big-play-button]');
        await page.$eval('.bottom-content', element => element.style.display = "none");
        await page.$eval('.fullscreen-button', element => element.style.opacity = "0");
        await page.$eval('.right', element => element.style.opacity = "0");
        await page.$eval('.vjs-control-bar', element => element.style.opacity = "0");
        await page.click('button[class=vjs-big-play-button]', {waitUntil: 'domcontentloaded'});

        //  Start capturing screen with ffmpeg
        const ls = child_process.spawn('sh', ['ffmpeg-cmd.sh', ' ',
            `${duration}`, ' ',
            `${exportName}`, ' ',
            `${disp_num}`, ' ',
            `${width}x${height}`, ' ',
            `${chromeInfoBarHeight}`, ' ',
            `${leftDarkLineWidth}`
        ], {
            shell: true
        });

        ls.stdout.on('data', (data) => {
            console.log(`stdout: ${data}`);
        });

        ls.stderr.on('data', (data) => {
            console.error(`stderr: ${data}`);
        });

        ls.on('close', (code) => {
            console.log(`child process exited with code ${code}`);
        });

        await page.waitFor((duration * 1000))

        logDone(exportName);
    } catch (err) {
        console.log(err)
        logError(exportName)
    } finally {
        if (page) {
            page.close && await page.close()
        }
        browser.close && await browser.close()
        // Stop xvfb after browser close
        xvfb.stopSync()
    }
}

function initLog() {
    let uuidFileName = randomUUID();
    logFileStream = fs.createWriteStream(recordingsFolder + uuidFileName, {flags: 'a'})
    return uuidFileName;
}

function logStart(exportName) {
    logFileStream = fs.createWriteStream(recordingsFolder + exportName + '.start', {flags: 'a'});
}

function logError(exportName) {
    fs.renameSync(recordingsFolder + exportName + '.start', recordingsFolder + exportName + '.error');
}

function logDone(exportName) {
    fs.renameSync(recordingsFolder + exportName + '.start', recordingsFolder + exportName + '.done');
}

async function sleepUtilNoOtherRecordingsRun() {
    while (true) {
        if (countStartFilesInFolder() === 0) {
            break;
        } else {
            await sleep(randomIntFromInterval(1000, 3000));
        }
    }
}

function sleep(ms) {
    return new Promise(resolve => {
        setTimeout(resolve, ms);
    });
}

function countStartFilesInFolder() {
    // count of files in folder that indicates recordings
    return fs.readdirSync(recordingsFolder)
        .filter(file => file.endsWith('.start'))
        .length;
}

// min and max included
function randomIntFromInterval(min, max) {
    return Math.floor(Math.random() * (max - min + 1) + min);
}

function logFunction(d) {
    logFileStream
        .write(d + '\n');
    process.stdout
        .write(d + '\n');
}

main();