'use strict';

import BaseController from './base-controller.js';
import { 
  sleep, 
  buf2hex, 
  dec2hex, 
  dec2hex32, 
  dec2hex8, 
  format_mac_from_view, 
  reverse_str, 
  la,
} from '../utils.js';
import { l } from '../translations.js';

// DS5 Button mapping configuration
const DS5_BUTTON_MAP = [
  { name: 'up', byte: 7, mask: 0x0 }, // Dpad handled separately
  { name: 'right', byte: 7, mask: 0x1 },
  { name: 'down', byte: 7, mask: 0x2 },
  { name: 'left', byte: 7, mask: 0x3 },
  { name: 'square', byte: 7, mask: 0x10, svg: 'Square' },
  { name: 'cross', byte: 7, mask: 0x20, svg: 'Cross' },
  { name: 'circle', byte: 7, mask: 0x40, svg: 'Circle' },
  { name: 'triangle', byte: 7, mask: 0x80, svg: 'Triangle' },
  { name: 'l1', byte: 8, mask: 0x01, svg: 'L1' },
  { name: 'l2', byte: 4, mask: 0xff }, // analog handled separately
  { name: 'r1', byte: 8, mask: 0x02, svg: 'R1' },
  { name: 'r2', byte: 5, mask: 0xff }, // analog handled separately
  { name: 'create', byte: 8, mask: 0x10, svg: 'Create' },
  { name: 'options', byte: 8, mask: 0x20, svg: 'Options' },
  { name: 'l3', byte: 8, mask: 0x40, svg: 'L3' },
  { name: 'r3', byte: 8, mask: 0x80, svg: 'R3' },
  { name: 'ps', byte: 9, mask: 0x01, svg: 'PS' },
  { name: 'touchpad', byte: 9, mask: 0x02, svg: 'Trackpad' },
  { name: 'mute', byte: 9, mask: 0x04, svg: 'Mute' },
];

// DS5 Input processing configuration
const DS5_INPUT_CONFIG = {
  buttonMap: DS5_BUTTON_MAP,
  dpadByte: 7,
  l2AnalogByte: 4,
  r2AnalogByte: 5,
  imuOffset: 15,
  touchpadOffset: 32,
};

// Usage counter block (test device 0x70). Sony's own tool (libFWupdater.dll) reads the same six pages on
// both models, from update version 0x0453 on a DualSense and 0x0177 on a DualSense Edge, and decodes them
// with a different layout per model (TelemetryDataDualSense / TelemetryDataDualSenseEdge).
const DS5_TELEMETRY_MIN_UPDATE_VERSION = 0x0453;
const DS5_EDGE_TELEMETRY_MIN_UPDATE_VERSION = 0x0177;
const DS5_TELEMETRY_PAGES = 6;

// Push counters of the standard DualSense layout: 4 bytes each, starting at offset 110
const DS5_TELEMETRY_BUTTONS = [
  '↑', '↓', '←', '→', '△', '✕', '□', '○',
  'L1', 'L2', 'L3', 'R1', 'R2', 'R3',
  null /* touchpad touch */, null /* touchpad click */,
  'Options', 'Create', 'PS', 'Mute',
];

// DualSense Edge layout: push counters start at offset 86 (4 bytes each). L2/R2 are counted per
// trigger stop and L3/R3 live in the stick module records instead.
const DS5_EDGE_TELEMETRY_BUTTONS_OFFSET = 86;
// Stick module records (37 bytes each): current left, current right, then two history slots
const DS5_EDGE_TELEMETRY_MODULES_OFFSET = 182;
const DS5_EDGE_TELEMETRY_MODULE_SIZE = 37;

// Unwritten NVRAM counters read back as 0xFF.. so treat those as zero
function telemetryU16(view, offset) {
  const v = view.getUint16(offset, true);
  return v === 0xFFFF ? 0 : v;
}

function telemetryU32(view, offset) {
  const v = view.getUint32(offset, true);
  return v === 0xFFFFFFFF ? 0 : v;
}

function telemetryU8(view, offset) {
  const v = view.getUint8(offset);
  return v === 0xFF ? 0 : v;
}

function formatDuration(totalSeconds) {
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts = [];
  if (days) parts.push(`${days}d`);
  if (days || hours) parts.push(`${hours}h`);
  if (days || hours || minutes) parts.push(`${minutes}m`);
  parts.push(`${seconds}s`);
  return parts.join(' ');
}

// Fields shared by both layouts (offsets 17..85)
function telemetryCommonItems(view) {
  const usage = (key, value) => ({ key, value, cat: "usage", isExtra: true });
  const error = (key, value) => ({ key, value, cat: "errors", isExtra: true });
  return [
    usage(l("Total Active Time"), formatDuration(telemetryU32(view, 21))),
    usage(l("Total Charging Time"), formatDuration(telemetryU32(view, 25))),
    usage(l("Haptics Active Time"), formatDuration(telemetryU32(view, 29))),
    usage(l("Adaptive Trigger Active Time (L / R)"),
      formatDuration(telemetryU32(view, 33)) + " / " + formatDuration(telemetryU32(view, 37))),
    usage(l("Telemetry Record Count"), telemetryU32(view, 17)),
    usage(l("Battery Charge Count"), telemetryU16(view, 41)),
    usage(l("Full Charge Count"), telemetryU16(view, 60)),
    usage(l("Charger Connect Count"), telemetryU16(view, 55)),
    usage(l("USB Connections"), telemetryU16(view, 66)),
    usage(l("USB SDP Detect Count"), telemetryU16(view, 43)),
    usage(l("USB CDP Detect Count"), telemetryU16(view, 45)),
    usage(l("USB DCP Detect Count"), telemetryU16(view, 47)),
    usage(l("USB Type-C 1.5A Detect Count"), telemetryU16(view, 49)),
    usage(l("USB Type-C 3.0A Detect Count"), telemetryU16(view, 51)),
    usage(l("USB Unknown Detect Count"), telemetryU16(view, 53)),
    usage(l("Bluetooth Connections"), telemetryU16(view, 68)),
    usage(l("Bluetooth Connect Timeouts"), telemetryU16(view, 70)),
    usage(l("Headset Detect Count"), telemetryU16(view, 62)),
    usage(l("Headphone Detect Count"), telemetryU16(view, 64)),
    error(l("Battery Charge Voltage Errors"), telemetryU8(view, 57)),
    error(l("Battery Charge Temperature Errors"), telemetryU8(view, 58)),
    error(l("Battery Charge PMIC Errors"), telemetryU8(view, 59)),
    error(l("Sub-CPU Startup Errors"), telemetryU16(view, 72)),
    error(l("Auth Challenge Count"), telemetryU32(view, 74)),
    error(l("Auth Success Count"), telemetryU32(view, 78)),
    error(l("Auth Fail Count"), telemetryU32(view, 82)),
  ];
}

function telemetryToInfoItems(view) {
  const usage = (key, value) => ({ key, value, cat: "usage", isExtra: true });
  const press = (key, value) => ({ key, value, cat: "presses", isExtra: true });
  const items = [
    ...telemetryCommonItems(view),
    usage(l("Left Stick Round Trips (X / Y)"), telemetryU32(view, 86) + " / " + telemetryU32(view, 92)),
    usage(l("Right Stick Round Trips (X / Y)"), telemetryU32(view, 98) + " / " + telemetryU32(view, 104)),
    usage(l("Left Stick Range (X / Y)"), telemetryU16(view, 90) + " / " + telemetryU16(view, 96)),
    usage(l("Right Stick Range (X / Y)"), telemetryU16(view, 102) + " / " + telemetryU16(view, 108)),
    press(l("Touchpad Touches"), telemetryU32(view, 110 + 14 * 4)),
    press(l("Touchpad Clicks"), telemetryU32(view, 110 + 15 * 4)),
  ];
  DS5_TELEMETRY_BUTTONS.forEach((name, i) => {
    if (name)
      items.push(press(name, telemetryU32(view, 110 + i * 4)));
  });
  return items;
}

// Serial numbers are 17 ASCII bytes, padded with 0x00 (or 0xFF when never written)
function telemetrySerial(view, offset) {
  let s = "";
  for (let i = 0; i < 17; i++) {
    const c = view.getUint8(offset + i);
    if (c === 0x00 || c === 0xFF) break;
    s += String.fromCharCode(c);
  }
  return s;
}

function edgeTelemetryModule(view, index) {
  const o = DS5_EDGE_TELEMETRY_MODULES_OFFSET + index * DS5_EDGE_TELEMETRY_MODULE_SIZE;
  return {
    serial: telemetrySerial(view, o),
    roundTrips: telemetryU32(view, o + 17) + " / " + telemetryU32(view, o + 23),
    range: telemetryU16(view, o + 21) + " / " + telemetryU16(view, o + 27),
    stickPresses: telemetryU32(view, o + 29),
    fnPresses: telemetryU32(view, o + 33),
  };
}

function edgeTelemetryToInfoItems(view) {
  const usage = (key, value, copyable) => ({ key, value, cat: "usage", isExtra: true, copyable });
  const press = (key, value) => ({ key, value, cat: "presses", isExtra: true });
  const counter = (i) => telemetryU32(view, DS5_EDGE_TELEMETRY_BUTTONS_OFFSET + i * 4);
  const stops = [l("Short"), l("Middle"), l("Full")];

  const left = edgeTelemetryModule(view, 0);
  const right = edgeTelemetryModule(view, 1);
  const items = [
    ...telemetryCommonItems(view),
    usage(l("Left Stick Round Trips (X / Y)"), left.roundTrips),
    usage(l("Right Stick Round Trips (X / Y)"), right.roundTrips),
    usage(l("Left Stick Range (X / Y)"), left.range),
    usage(l("Right Stick Range (X / Y)"), right.range),
  ];

  // Sony's stickModuleHistory1/2 records; slots that were never written have no serial
  for (let slot = 1; slot <= 2; slot++) {
    const prev = edgeTelemetryModule(view, 1 + slot);
    if (!prev.serial) continue;
    const name = l("Stick Module History") + " " + slot;
    items.push(
      usage(name, prev.serial, true),
      usage(name + " " + l("Round Trips (X / Y)"), prev.roundTrips),
      usage(name + " " + l("Range (X / Y)"), prev.range),
      usage(name + " " + l("Presses (Stick / Fn)"), prev.stickPresses + " / " + prev.fnPresses),
    );
  }

  ['↑', '↓', '←', '→', '△', '✕', '□', '○', 'L1'].forEach((name, i) => items.push(press(name, counter(i))));
  stops.forEach((stop, i) => items.push(press(`L2 (${stop})`, counter(9 + i))));
  items.push(press('R1', counter(12)));
  stops.forEach((stop, i) => items.push(press(`R2 (${stop})`, counter(13 + i))));
  items.push(
    press(l("Touchpad Touches"), counter(16)),
    press(l("Touchpad Clicks"), counter(17)),
    press('Options', counter(18)),
    press('Create', counter(19)),
    press('PS', counter(20)),
    press('Mute', counter(21)),
    press('LB', counter(22)),
    press('RB', counter(23)),
    press('L3', left.stickPresses),
    press('R3', right.stickPresses),
    press('Fn L', left.fnPresses),
    press('Fn R', right.fnPresses),
  );
  return items;
}

// DS5 Adaptive Trigger Effect Modes
const DS5_TRIGGER_EFFECT_MODE = {
  OFF: 0x00,           // No effect
  RESISTANCE: 0x01,    // Constant resistance
  TRIGGER: 0x02,       // Single-trigger effect with release
  AUTO_TRIGGER: 0x06,  // Automatic trigger with vibration
};

// DS5 Output Report Constants
const DS5_OUTPUT_REPORT = {
  USB_REPORT_ID: 0x02,
  BT_REPORT_ID: 0x31,
}

const DS5_VALID_FLAG0 = {
  RIGHT_VIBRATION: 0x01,  // Bit 0 for right vibration motor
  LEFT_VIBRATION: 0x02,   // Bit 1 for left vibration motor
  LEFT_TRIGGER: 0x04,     // Bit 2 for left adaptive trigger
  RIGHT_TRIGGER: 0x08,    // Bit 3 for right adaptive trigger
  HEADPHONE_VOLUME: 0x10, // Bit 4 for headphone volume control
  SPEAKER_VOLUME: 0x20,   // Bit 5 for speaker volume control
  MIC_VOLUME: 0x40,       // Bit 6 for microphone volume control
  AUDIO_CONTROL: 0x80,    // Bit 7 for audio control
};

const DS5_VALID_FLAG1 = {
  MUTE_LED: 0x01,          // Bit 0 for mute LED control
  POWER_SAVE_MUTE: 0x02,   // Bit 1 for power-save mute control
  LIGHTBAR_COLOR: 0x04,    // Bit 2 for lightbar color control
  RESERVED_BIT_3: 0x08,    // Bit 3 (reserved)
  PLAYER_INDICATOR: 0x10,  // Bit 4 for player indicator LED control
  LED_BRIGHTNESS: 0x20,    // Bit 6 for LED brightness control
  LIGHTBAR_SETUP: 0x40,    // Bit 6 for lightbar setup control
  RESERVED_BIT_7: 0x80,    // Bit 7 (reserved)
}

const DS5_VALID_FLAG2 = {
  LED_BRIGHTNESS: 0x01,         // Bit 0 for LED brightness control
  LIGHTBAR_SETUP: 0x02,         // Bit 1 for lightbar setup control
};

// Basic DS5 Output Structure for adaptive trigger control
class DS5OutputStruct {
  constructor(currentState = null) {
    // Create a 47-byte buffer for DS5 output report (USB)
    this.buffer = new ArrayBuffer(47);
    this.view = new DataView(this.buffer);

    // Control flags
    this.validFlag0 = currentState.validFlag0 || 0;
    this.validFlag1 = currentState.validFlag1 || 0;
    this.validFlag2 = currentState.validFlag2 || 0;

    // Vibration motors
    this.bcVibrationRight = currentState.bcVibrationRight || 0;
    this.bcVibrationLeft = currentState.bcVibrationLeft || 0;

    // Audio control
    this.headphoneVolume = currentState.headphoneVolume || 0;
    this.speakerVolume = currentState.speakerVolume || 0;
    this.micVolume = currentState.micVolume || 0;
    this.audioControl = currentState.audioControl || 0;
    this.audioControl2 = currentState.audioControl2 || 0;

    // LED and indicator control
    this.muteLedControl = currentState.muteLedControl || 0;
    this.powerSaveMuteControl = currentState.powerSaveMuteControl || 0;
    this.lightbarSetup = currentState.lightbarSetup || 0;
    this.ledBrightness = currentState.ledBrightness || 0;
    this.playerIndicator = currentState.playerIndicator || 0;
    this.ledCRed = currentState.ledCRed || 0;
    this.ledCGreen = currentState.ledCGreen || 0;
    this.ledCBlue = currentState.ledCBlue || 0;

    // Adaptive trigger parameters
    this.adaptiveTriggerLeftMode = currentState.adaptiveTriggerLeftMode || 0;
    this.adaptiveTriggerLeftParam0 = currentState.adaptiveTriggerLeftParam0 || 0;
    this.adaptiveTriggerLeftParam1 = currentState.adaptiveTriggerLeftParam1 || 0;
    this.adaptiveTriggerLeftParam2 = currentState.adaptiveTriggerLeftParam2 || 0;

    this.adaptiveTriggerRightMode = currentState.adaptiveTriggerRightMode || 0;
    this.adaptiveTriggerRightParam0 = currentState.adaptiveTriggerRightParam0 || 0;
    this.adaptiveTriggerRightParam1 = currentState.adaptiveTriggerRightParam1 || 0;
    this.adaptiveTriggerRightParam2 = currentState.adaptiveTriggerRightParam2 || 0;

    // Haptic feedback
    this.hapticVolume = currentState.hapticVolume || 0;
  }

  // Pack the data into the output buffer
  pack() {
    // Based on DS5 output report structure from HID descriptor
    // Byte 0-1: Control flags (16-bit little endian)
    this.view.setUint16(0, (this.validFlag1 << 8) | this.validFlag0, true);

    // Byte 2-3: Vibration motors
    this.view.setUint8(2, this.bcVibrationRight);
    this.view.setUint8(3, this.bcVibrationLeft);

    // Bytes 4-7: Audio control (reserved for now)
    this.view.setUint8(4, this.headphoneVolume);
    this.view.setUint8(5, this.speakerVolume);
    this.view.setUint8(6, this.micVolume);
    this.view.setUint8(7, this.audioControl);

    // Byte 8: Mute LED control
    this.view.setUint8(8, this.muteLedControl);

    // Byte 9: Reserved
    this.view.setUint8(9, 0);

    // Bytes 10-20: Right adaptive trigger
    this.view.setUint8(10, this.adaptiveTriggerRightMode);
    this.view.setUint8(11, this.adaptiveTriggerRightParam0);
    this.view.setUint8(12, this.adaptiveTriggerRightParam1);
    this.view.setUint8(13, this.adaptiveTriggerRightParam2);
    // Additional trigger parameters (bytes 14-20 reserved for extended params)
    for (let i = 14; i <= 20; i++) {
      this.view.setUint8(i, 0);
    }

    // Bytes 21-31: Left adaptive trigger
    this.view.setUint8(21, this.adaptiveTriggerLeftMode);
    this.view.setUint8(22, this.adaptiveTriggerLeftParam0);
    this.view.setUint8(23, this.adaptiveTriggerLeftParam1);
    this.view.setUint8(24, this.adaptiveTriggerLeftParam2);
    // Additional trigger parameters (bytes 25-31 reserved for extended params)
    for (let i = 25; i <= 31; i++) {
      this.view.setUint8(i, 0);
    }

    // Bytes 32-42: Reserved
    for (let i = 32; i <= 42; i++) {
      this.view.setUint8(i, 0);
    }

    // Byte 43: Player LED indicator
    this.view.setUint8(43, this.playerIndicator);

    // Bytes 44-46: Lightbar RGB
    this.view.setUint8(44, this.ledCRed);
    this.view.setUint8(45, this.ledCGreen);
    this.view.setUint8(46, this.ledCBlue);

    return this.buffer;
  }
}

function ds5_color(serialNumber) {
  // Color is obtained by the 5th and 6th characters of the serial number
  // e.g. A12305xxx0000000 -> '05' -> Starlight Blue
  const colorMap = {
    '00': 'White',
    '01': 'Midnight Black',
    '02': 'Cosmic Red',
    '03': 'Nova Pink',
    '04': 'Galactic Purple',
    '05': 'Starlight Blue',
    '06': 'Grey Camouflage',
    '07': 'Volcanic Red',
    '08': 'Sterling Silver',
    '09': 'Cobalt Blue',
    '10': 'Chroma Teal',
    '11': 'Chroma Indigo',
    '12': 'Chroma Pearl',
    '13': 'HyperPop Techno Red',
    '14': 'HyperPop Remix Green',
    '15': 'HyperPop Rhythm Blue',
    '30': '30th Anniversary',
    'Z1': 'God of War Ragnarok',
    'Z2': 'Spider-Man 2',
    'Z3': 'Astro Bot',
    'Z4': 'Fortnite',
    'Z6': 'The Last of Us',
    'ZA': 'God of War 20th Anniversary',
    'ZB': 'Icon Blue Limited Edition',
    'ZC': 'Ghost of Yōtei Limited Edition',
    'ZD': 'Marathon Limited Edition',
    'ZE': 'Genshin Impact Limited Edition',
    'ZF': '007 First Light Limited Edition',
  };

  const colorCode = serialNumber.slice(4, 6);
  const colorName = colorMap[colorCode] || 'Unknown';
  return colorName;
}

/**
* DualSense (DS5) Controller implementation
*/
class DS5Controller extends BaseController {
  constructor(device) {
    super(device);
    this.model = "DS5";
    this.finetuneMaxValue = 65535; // 16-bit max value for DS5

    // Initialize current output state to track controller settings
    this.currentOutputState = {
      validFlag0: 0,
      validFlag1: 0,
      validFlag2: 0,
      bcVibrationRight: 0,
      bcVibrationLeft: 0,
      headphoneVolume: 0,
      speakerVolume: 0,
      micVolume: 0,
      audioControl: 0,
      audioControl2: 0,
      muteLedControl: 0,
      powerSaveMuteControl: 0,
      lightbarSetup: 0,
      ledBrightness: 0,
      playerIndicator: 0,
      ledCRed: 0,
      ledCGreen: 0,
      ledCBlue: 0,
      adaptiveTriggerLeftMode: 0,
      adaptiveTriggerLeftParam0: 0,
      adaptiveTriggerLeftParam1: 0,
      adaptiveTriggerLeftParam2: 0,
      adaptiveTriggerRightMode: 0,
      adaptiveTriggerRightParam0: 0,
      adaptiveTriggerRightParam1: 0,
      adaptiveTriggerRightParam2: 0,
      hapticVolume: 0
    };
  }

  getInputConfig() {
    return DS5_INPUT_CONFIG;
  }

  async getSerialNumber() {
    return await this.getSystemInfo(1, 19, 17);
  }

  async getInfo() {
    return this._getInfo(false);
  }

  async _getInfo(is_edge) {
    // Device-only: collect info and return a common structure; do not touch the DOM
    try {
      console.log("Fetching DS5 info...");
      const view = await this.receiveFeatureReport(0x20);
      console.log("Got DS5 info report:", buf2hex(view.buffer));
      const cmd = view.getUint8(0, true);
      if(cmd != 0x20 || view.buffer.byteLength != 64)
        return { ok: false, error: new Error("Invalid response for ds5_info") };

      const build_date = new TextDecoder().decode(view.buffer.slice(1, 1+11));
      const build_time = new TextDecoder().decode(view.buffer.slice(12, 20));

      const fwtype     = view.getUint16(20, true);
      const swseries   = view.getUint16(22, true);
      const hwinfo     = view.getUint32(24, true);
      const fwversion  = view.getUint32(28, true);

      const updversion = view.getUint16(44, true);
      const unk        = view.getUint8(46, true);

      const fwversion1 = view.getUint32(48, true);
      const fwversion2 = view.getUint32(52, true);
      const fwversion3 = view.getUint32(56, true);

      const touchpad_id = await this.getSystemInfo(5, 2, 8, false);
      const touchpad_fw = await this.getSystemInfo(5, 4, 8, false);
      const serial_number = await this.getSystemInfo(1, 19, 17);
      const report22 = await this.getReport22();
      const color = ds5_color(serial_number);
      const infoItems = [
        { key: l("Serial Number"), value: serial_number, cat: "hw", copyable: true },
        { key: l("MCU Unique ID"), value: await this.getSystemInfo(1, 9, 9, false), cat: "hw", isExtra: true, copyable: true },
        { key: l("PCBA ID"), value: reverse_str(await this.getSystemInfo(1, 17, 14)), cat: "hw", isExtra: true },
        { key: l("Battery Barcode"), value: await this.getSystemInfo(1, 24, 23), cat: "hw", isExtra: true, copyable: true },
        { key: l("VCM Left Barcode"), value: await this.getSystemInfo(1, 26, 16), cat: "hw", isExtra: true, copyable: true },
        { key: l("VCM Right Barcode"), value: await this.getSystemInfo(1, 28, 16), cat: "hw", isExtra: true, copyable: true },

        { key: l("Color"), value: l(color), cat: "hw", addInfoIcon: 'color', copyable: true },

        ...(is_edge ? [] : [{ key: l("Board Model"), value: this.hwToBoardModel(hwinfo), cat: "hw", addInfoIcon: 'board', copyable: true }]),

        { key: l("FW Build Date"), value: build_date + " " + build_time, cat: "fw" },
        { key: l("FW Type"), value: "0x" + dec2hex(fwtype), cat: "fw", isExtra: true },
        { key: l("FW Series"), value: "0x" + dec2hex(swseries), cat: "fw", isExtra: true },
        { key: l("HW Model"), value: "0x" + dec2hex32(hwinfo), cat: "hw", isExtra: true },
        { key: l("FW Version"), value: "0x" + dec2hex32(fwversion), cat: "fw", isExtra: true },
        { key: l("FW Update"), value: "0x" + dec2hex(updversion), cat: "fw", isExtra: true },
        { key: l("FW Update Info"), value: "0x" + dec2hex8(unk), cat: "fw", isExtra: true },
        { key: l("SBL FW Version"), value: "0x" + dec2hex32(fwversion1), cat: "fw", isExtra: true },
        { key: l("Venom FW Version"), value: "0x" + dec2hex32(fwversion2), cat: "fw", isExtra: true },
        { key: l("Spider FW Version"), value: "0x" + dec2hex32(fwversion3), cat: "fw", isExtra: true },

        // Many controllers (any board, incl. BDM-010 on 2024 firmware) and clones
        // don't answer the touchpad query
        ...(touchpad_id !== l("error") ? [{ key: l("Touchpad ID"), value: touchpad_id, cat: "hw", isExtra: true, copyable: true }] : []),
        ...(touchpad_fw !== l("error") ? [{ key: l("Touchpad FW Version"), value: touchpad_fw, cat: "fw", isExtra: true }] : []),
      ];

      const old_controller = build_date.search(/ 2020| 2021/);
      let disable_bits = 0;
      if(old_controller != -1) {
        la("ds5_info_error", {"r": "old"})
        disable_bits |= 2; // 2: outdated firmware
      }

      const clone_reason = await this.detectClone(build_date);
      if(clone_reason) {
        la("clone", { "r": clone_reason });
        disable_bits |= 1; // 1: clone
      }
      infoItems.push({ key: l("Device Type"), value: clone_reason ? l("clone") : l("original"), cat: "hw", severity: clone_reason ? 'danger' : undefined });

      const nv = await this.queryNvStatus();
      const bd_addr = await this.getBdAddr();
      infoItems.push({ key: l("Bluetooth Address"), value: bd_addr, cat: "hw", isExtra: true });

      const host_addr = await this.getPairedHostAddr();
      if (host_addr)
        infoItems.push({ key: l("Paired Host Address"), value: host_addr, cat: "hw", isExtra: true });

      const battery_mv = await this.getBatteryVoltage();
      if (battery_mv !== null)
        infoItems.push({ key: l("Battery Voltage"), value: (battery_mv / 1000).toFixed(2) + " V", cat: "hw", isExtra: true });

      if (report22?.bt_patch)
        infoItems.push({ key: l("BT Patch Version"), value: "0x" + dec2hex32(report22.bt_patch), cat: "fw", isExtra: true });

      // Fields with no documented meaning; shown in their own card
      const unconfirmed = (key, value) => ({ key, value, cat: "unconfirmed", isExtra: true });
      if (report22?.id) {
        infoItems.push(
          unconfirmed(l("Unknown ID (0x22)"), report22.id),
          unconfirmed(l("Unknown Version (0x22)"), report22.version),
          unconfirmed(l("Unknown Value (0x22)"), report22.value),
        );
      }

      const cmd43_word1 = await this.getCmd43Word1();
      if (cmd43_word1 !== null)
        infoItems.push(unconfirmed(l("Unknown (cmd 4,3)"), String(cmd43_word1)));

      const telemetry_min = is_edge ? DS5_EDGE_TELEMETRY_MIN_UPDATE_VERSION : DS5_TELEMETRY_MIN_UPDATE_VERSION;
      if (updversion >= telemetry_min) {
        const telemetry = await this.readTelemetry();
        if (telemetry)
          infoItems.push(...(is_edge ? edgeTelemetryToInfoItems(telemetry) : telemetryToInfoItems(telemetry)));
      }

      const pending_reboot = (nv?.status === 'pending_reboot');

      return { ok: true, infoItems, nv, disable_bits, pending_reboot };
    } catch(error) {
      la("ds5_info_error", {"r": error})
      return { ok: false, error, disable_bits: 1 };
    }
  }

  async flash(progressCallback = null) {
    la("ds5_flash");
    try {
      await this.nvsUnlock();
      const lockRes = await this.nvsLock();
      if(!lockRes.ok) throw (lockRes.error || new Error("NVS lock failed"));

      return { success: true, message: l("Changes saved successfully") };
    } catch(error) {
      throw new Error(l("Error while saving changes"), { cause: error });
    }
  }

  async reset() {
    la("ds5_reset");
    try {
      await this.sendFeatureReport(0x80, [1,1]);
    } catch(error) {
    }
  }

  async nvsLock() {
    // la("ds5_nvlock");
    try {
      await this.sendFeatureReport(0x80, [3,1]);
      await this.receiveFeatureReport(0x81);
      return { ok: true };
    } catch(error) {
      return { ok: false, error };
    }
  }

  async nvsUnlock() {
    // la("ds5_nvunlock");
    try {
      await this.sendFeatureReport(0x80, [3,2, 101, 50, 64, 12]);
      const data = await this.receiveFeatureReport(0x81);
    } catch(error) {
      await sleep(500);
      throw new Error(l("NVS Unlock failed"), { cause: error });
    }
  }

  async getBdAddr() {
    await this.sendFeatureReport(0x80, [9,2]);
    const data = await this.receiveFeatureReport(0x81);
    return format_mac_from_view(data, 4);
  }

  /**
   * Run a factory test command: SET 0x80 [device, action], then poll 0x81 until it echoes
   * [device, action, 2 (complete)]. Returns the payload, or null when the firmware ignores the
   * command (unsupported commands never get an answer, 0x81 just stays zeroed).
   */
  async testCommand(device, action, length) {
    await this.sendFeatureReport(0x80, [device, action]);
    for (let attempt = 0; attempt < 5; attempt++) {
      const view = await this.receiveFeatureReport(0x81);
      if (view.getUint8(1) === device && view.getUint8(2) === action && view.getUint8(3) === 2)
        return view.buffer.slice(4, 4 + length);
      await sleep(10);
    }
    return null;
  }

  async getSystemInfo(base, num, length, decode = true) {
    const data = await this.testCommand(base, num, length);
    if (!data)
      return l("error");
    return decode ? new TextDecoder().decode(data) : buf2hex(data);
  }

  /**
   * Battery voltage in mV, or null. Test command (2,6) is named BATTERY_VOLTAGE in the test command
   * table of daidr's dualsense-tester; word 0 of command (4,3) reads back the same value.
   */
  async getBatteryVoltage() {
    try {
      const data = await this.testCommand(2, 6, 2);
      const mv = data ? new DataView(data).getUint16(0, true) : 0;
      return mv ? mv : null;
    } catch (_e) {
      return null;
    }
  }

  /** Word 1 of test command (4,3), whose word 0 mirrors the battery voltage; meaning unknown, or null. */
  async getCmd43Word1() {
    try {
      const data = await this.testCommand(4, 3, 4);
      const raw = data ? new DataView(data).getUint16(2, true) : 0;
      return (raw === 0 || raw === 0xFFFF) ? null : raw;
    } catch (_e) {
      return null;
    }
  }

  /**
   * Feature report 0x22, or null. Bytes 31-34 are the BT patch version as named by daidr's
   * dualsense-tester; the meaning of the other fields decoded here is unknown.
   */
  async getReport22() {
    try {
      const view = await this.receiveFeatureReport(0x22);
      if (view.getUint8(0) !== 0x22 || view.byteLength < 52)
        return null;
      let id = "";
      for (let i = 45; i < view.byteLength; i++) {
        const c = view.getUint8(i);
        if (c < 0x20 || c >= 0x7f) break;
        id += String.fromCharCode(c);
      }
      return {
        bt_patch: view.getUint32(31, true),
        id,
        version: [39, 40, 41, 42].map(i => view.getUint8(i)).join("."),
        value: buf2hex(view.buffer.slice(35, 39)),
      };
    } catch (_e) {
      return null;
    }
  }

  /**
   * Feature report 0x09 bytes 10-15: address of the host the controller is paired with, or null.
   * Same layout as the DualShock 4's report 0x12; checked against a known host on real hardware.
   */
  async getPairedHostAddr() {
    try {
      const view = await this.receiveFeatureReport(0x09);
      if (view.getUint8(0) !== 0x09 || view.byteLength < 16)
        return null;
      const addr = format_mac_from_view(view, 10);
      return addr === "00:00:00:00:00:00" ? null : addr;
    } catch (_e) {
      return null;
    }
  }

  /**
   * Read the usage counter block (test device 0x70, action 1), the same block Sony's
   * PlayStation Accessories app reads as telemetry (libFWupdater.dll). The controller answers with six 56-byte
   * pages (status 3 = more pages follow, 2 = last page). Returns a DataView over the block, or null.
   */
  async readTelemetry() {
    try {
      await this.sendFeatureReport(0x80, [0x70, 1]);
      const block = new Uint8Array(DS5_TELEMETRY_PAGES * 56);
      let page = 0;
      for (let attempt = 0; attempt < DS5_TELEMETRY_PAGES * 4 && page < DS5_TELEMETRY_PAGES; attempt++) {
        const view = await this.receiveFeatureReport(0x81);
        const status = view.getUint8(3);
        if (view.getUint8(1) === 0x70 && view.getUint8(2) === 1 && (status === 2 || status === 3)) {
          block.set(new Uint8Array(view.buffer.slice(4, 60)), page * 56);
          page++;
          if (status === 2)
            break;
        } else {
          await sleep(10);
        }
      }
      // Byte 0 is a status byte; the counters start right after it
      return page === DS5_TELEMETRY_PAGES ? new DataView(block.buffer, 1) : null;
    } catch (_e) {
      return null;
    }
  }

  async calibrateSticksBegin() {
    la("ds5_calibrate_sticks_begin");
    try {
      // Begin
      await this.sendFeatureReport(0x82, [1,1,1]);

      // Assert
      const data = await this.receiveFeatureReport(0x83);
      if(data.getUint32(0, false) != 0x83010101) {
        const d1 = dec2hex32(data.getUint32(0, false));
        la("ds5_calibrate_sticks_begin_failed", {"d1": d1});
        throw new Error(`Stick center calibration begin failed: ${d1}`);
      }
      return { ok: true };
    } catch(error) {
      la("ds5_calibrate_sticks_begin_failed", {"r": error});
      return { ok: false, error };
    }
  }

  async calibrateSticksSample() {
    la("ds5_calibrate_sticks_sample");
    try {
      // Sample
      await this.sendFeatureReport(0x82, [3,1,1]);

      // Assert
      const data = await this.receiveFeatureReport(0x83);
      if(data.getUint32(0, false) != 0x83010101) {
        const d1 = dec2hex32(data.getUint32(0, false));
        la("ds5_calibrate_sticks_sample_failed", {"d1": d1});
        throw new Error(`Stick center calibration sample failed: ${d1}`);
      }
      return { ok: true };
    } catch(error) {
      la("ds5_calibrate_sticks_sample_failed", {"r": error});
      return { ok: false, error };
    }
  }

  async calibrateSticksEnd() {
    la("ds5_calibrate_sticks_end");
    try {
      // Write
      await this.sendFeatureReport(0x82, [2,1,1]);

      const data = await this.receiveFeatureReport(0x83);

      if(data.getUint32(0, false) != 0x83010102) {
        const d1 = dec2hex32(data.getUint32(0, false));
        la("ds5_calibrate_sticks_failed", {"s": 3, "d1": d1});
        throw new Error(`Stick center calibration end failed: ${d1}`);
      }

      return { ok: true };
    } catch(error) {
      la("ds5_calibrate_sticks_end_failed", {"r": error});
      return { ok: false, error };
    }
  }

  async calibrateRangeBegin() {
    la("ds5_calibrate_range_begin");
    try {
      // Begin
      await this.sendFeatureReport(0x82, [1,1,2]);

      // Assert
      const data = await this.receiveFeatureReport(0x83);
      if(data.getUint32(0, false) != 0x83010201) {
        const d1 = dec2hex32(data.getUint32(0, false));
        la("ds5_calibrate_range_begin_failed", {"d1": d1});
        throw new Error(`Stick range calibration begin failed: ${d1}`);
      }
      return { ok: true };
    } catch(error) {
      la("ds5_calibrate_range_begin_failed", {"r": error});
      return { ok: false, error };
    }
  }

  async calibrateRangeEnd() {
    la("ds5_calibrate_range_end");
    try {
      // Write
      await this.sendFeatureReport(0x82, [2,1,2]);

      // Assert
      const data = await this.receiveFeatureReport(0x83);

      if(data.getUint32(0, false) != 0x83010202) {
        const d1 = dec2hex32(data.getUint32(0, false));
        la("ds5_calibrate_range_end_failed", {"d1": d1});
        throw new Error(`Stick range calibration end failed: ${d1}`);
      }

      return { ok: true };
    } catch(error) {
      la("ds5_calibrate_range_end_failed", {"r": error});
      return { ok: false, error };
    }
  }

  async queryNvStatus() {
    try {
      await this.sendFeatureReport(0x80, [3,3]);
      const data = await this.receiveFeatureReport(0x81);
      const ret = data.getUint32(1, false);
      if (ret === 0x15010100) {
        return { device: 'ds5', status: 'pending_reboot', locked: null, code: 4, raw: ret };
      }
      if (ret === 0x03030201) {
        return { device: 'ds5', status: 'locked', locked: true, mode: 'temporary', code: 1, raw: ret };
      }
      if (ret === 0x03030200) {
        return { device: 'ds5', status: 'unlocked', locked: false, mode: 'permanent', code: 0, raw: ret };
      }
      if (ret === 1 || ret === 2) {
        return { device: 'ds5', status: 'unknown', locked: null, code: 2, raw: ret };
      }
      return { device: 'ds5', status: 'unknown', locked: null, code: ret, raw: ret };
    } catch (error) {
      return { device: 'ds5', status: 'error', locked: null, code: 2, error };
    }
  }

  hwToBoardModel(hw_ver) {
    const a = (hw_ver >> 8) & 0xff;
    if(a == 0x03) return "BDM-010";
    if(a == 0x04) return "BDM-020";
    if(a == 0x05) return "BDM-030";
    if(a == 0x06) return "BDM-040";
    if(a == 0x07 || a == 0x08) return "BDM-050";
    if(a == 0x09) return "BDM-060R";
    // TODO 0x10?
    if(a == 0x11) return "BDM-060M";
    // TODO 0x12?
    if(a == 0x13) return "BDM-060X";
    return l("Unknown");
  }

  /**
   * Look for signs that this is a counterfeit DualSense (issue #222).
   * @param {string} build_date - FW build date from report 0x20, e.g. "Jan 29 2024"
   * @returns {string|null} Short reason if it looks like a clone, otherwise null
   */
  async detectClone(build_date) {
    // A firmware built in a future year can't be genuine (one clone reports "Jan 29 2034")
    const build_year = parseInt(build_date.trim().slice(-4), 10);
    if(build_year > new Date().getFullYear()) {
      return "build_date";
    }

    // Every genuine controller answers the stick finetune query; this is also
    // what the connect flow reads to save the finetune history
    try {
      if(!(await this.getInMemoryModuleData())) {
        return "finetune";
      }
    } catch(_e) {
      return "finetune";
    }
    return null;
  }

  async getInMemoryModuleData() {
    // DualSense
    await this.sendFeatureReport(0x80, [12, 2]);
    await sleep(100);
    const data = await this.receiveFeatureReport(0x81);
    const cmd = data.getUint8(0, true);
    const [p1, p2, p3] = [1, 2, 3].map(i => data.getUint8(i, true));

    if(cmd != 129 || p1 != 12 || (p2 != 2 && p2 != 4) || p3 != 2)
      return null;

    return Array.from({ length: 12 }, (_, i) => data.getUint16(4 + i * 2, true));
  }

  async writeFinetuneData(data) {
    const pkg = data.reduce((acc, val) => acc.concat([val & 0xff, val >> 8]), [12, 1]);
    await this.sendFeatureReport(0x80, pkg);
  }

  /**
   * Send output report to the DS5 controller
   * @param {ArrayBuffer} data - The output report data
   */
  async sendOutputReport(data, reason = "") {
    if (!this.device?.opened) {
      throw new Error('Device is not opened');
    }
    try {
      console.log(`Sending output report${ reason ? ` to ${reason}` : '' }:`, DS5_OUTPUT_REPORT.USB_REPORT_ID, buf2hex(data));
      await this.device.sendReport(DS5_OUTPUT_REPORT.USB_REPORT_ID, new Uint8Array(data));
    } catch (error) {
      throw new Error(`Failed to send output report: ${error.message}`);
    }
  }

  /**
   * Update the current output state with values from an OutputStruct
   * @param {DS5OutputStruct} outputStruct - The output structure to copy state from
   */
  updateCurrentOutputState(outputStruct) {
    this.currentOutputState = { ...outputStruct };
  }

  /**
   * Get a copy of the current output state
   * @returns {Object} A copy of the current output state
   */
  getCurrentOutputState() {
    return { ...this.currentOutputState };
  }

  /**
   * Initialize the current output state when the controller is first connected.
   * Since DS5 controllers don't provide a way to read the current output state,
   * this method sets up reasonable defaults and attempts to detect any current settings.
   */
  async initializeCurrentOutputState() {
    try {
      // Reset all output state to known defaults
      this.currentOutputState = {
        ...this.getCurrentOutputState(),
        validFlag1: 0b1111_0111,
        ledCRed: 0,
        ledCGreen: 0,
        ledCBlue: 255,
      };

      // Send a "reset" output report to ensure the controller is in a known state
      // This will turn off any existing effects and set the controller to defaults
      const resetOutputStruct = new DS5OutputStruct(this.currentOutputState);
      await this.sendOutputReport(resetOutputStruct.pack(), 'init default states');

      // Update our state to reflect what we just sent
      this.updateCurrentOutputState(resetOutputStruct);
    } catch (error) {
      console.warn("Failed to initialize DS5 output state:", error);
      // Even if the reset fails, we still have the default state initialized
    }
  }

  /**
   * Set left adaptive trigger to single-trigger mode
   */
  async setAdaptiveTrigger(left, right) {
    try {
      const modeMap = {
        'off': DS5_TRIGGER_EFFECT_MODE.OFF,
        'single': DS5_TRIGGER_EFFECT_MODE.TRIGGER,
        'auto': DS5_TRIGGER_EFFECT_MODE.AUTO_TRIGGER,
        'resistance': DS5_TRIGGER_EFFECT_MODE.RESISTANCE,
      }

      // Create output structure with current controller state
      const { validFlag0 } = this.currentOutputState;
      const outputStruct = new DS5OutputStruct({
        ...this.currentOutputState,
        adaptiveTriggerLeftMode: modeMap[left.mode],
        adaptiveTriggerLeftParam0: left.start,
        adaptiveTriggerLeftParam1: left.end,
        adaptiveTriggerLeftParam2: left.force,

        adaptiveTriggerRightMode: modeMap[right.mode],
        adaptiveTriggerRightParam0: right.start,
        adaptiveTriggerRightParam1: right.end,
        adaptiveTriggerRightParam2: right.force,

        validFlag0: validFlag0 | DS5_VALID_FLAG0.LEFT_TRIGGER | DS5_VALID_FLAG0.RIGHT_TRIGGER,
      });
      await this.sendOutputReport(outputStruct.pack(), 'set adaptive trigger mode');
      outputStruct.validFlag0 &= ~(DS5_VALID_FLAG0.LEFT_TRIGGER | DS5_VALID_FLAG0.RIGHT_TRIGGER);

      // Update current state to reflect the changes
      this.updateCurrentOutputState(outputStruct);

      return { success: true };
    } catch (error) {
      throw new Error("Failed to set left adaptive trigger mode", { cause: error });
    }
  }

  /**
   * Set vibration motors for haptic feedback
   * @param {number} heavyLeft - Left motor intensity (0-255)
   * @param {number} lightRight - Right motor intensity (0-255)
   */
  async setVibration(heavyLeft = 0, lightRight = 0) {
    try {
      const { validFlag0 } = this.currentOutputState;
      const outputStruct = new DS5OutputStruct({
        ...this.currentOutputState,
        bcVibrationLeft: Math.max(0, Math.min(255, heavyLeft)),
        bcVibrationRight: Math.max(0, Math.min(255, lightRight)),
        validFlag0: validFlag0 | DS5_VALID_FLAG0.LEFT_VIBRATION | DS5_VALID_FLAG0.RIGHT_VIBRATION, // Update both vibration motors
      });
      await this.sendOutputReport(outputStruct.pack(), 'set vibration');
      outputStruct.validFlag0 &= ~(DS5_VALID_FLAG0.LEFT_VIBRATION | DS5_VALID_FLAG0.RIGHT_VIBRATION);

      // Update current state to reflect the changes
      this.updateCurrentOutputState(outputStruct);
    } catch (error) {
      throw new Error("Failed to set vibration", { cause: error });
    }
  }

  /**
   * Test speaker tone by controlling speaker volume and audio settings
   * This creates a brief audio feedback through the controller's speaker or headphones
   * @param {string} output - Audio output destination: "speaker" (default) or "headphones"
   */
  async setSpeakerTone(output = "speaker") {
    try {
      const { validFlag0 } = this.currentOutputState;
      const outputStruct = new DS5OutputStruct({
        ...this.currentOutputState,
        speakerVolume: 85,
        headphoneVolume: 55,
        validFlag0: validFlag0 | DS5_VALID_FLAG0.HEADPHONE_VOLUME | DS5_VALID_FLAG0.SPEAKER_VOLUME | DS5_VALID_FLAG0.AUDIO_CONTROL,
      });
      await this.sendOutputReport(outputStruct.pack(), output === "headphones" ? 'play headphone tone' : 'play speaker tone');
      outputStruct.validFlag0 &= ~(DS5_VALID_FLAG0.HEADPHONE_VOLUME | DS5_VALID_FLAG0.SPEAKER_VOLUME | DS5_VALID_FLAG0.AUDIO_CONTROL);

      // Send feature reports to enable audio
      if (output === "headphones") {
        // Audio configuration command for headphones
        await this.sendFeatureReport(128, [6, 4, 0, 0, 0, 0, 4, 0, 6]);
        // Enable headphone tone
        await this.sendFeatureReport(128, [6, 2, 1, 1, 0]);
      } else {
        // Audio configuration command for speakers
        await this.sendFeatureReport(128, [6, 4, 0, 0, 8]);
        // Enable speaker tone
        await this.sendFeatureReport(128, [6, 2, 1, 1, 0]);
      }

      // Update current state to reflect the changes
      this.updateCurrentOutputState(outputStruct);
    } catch (error) {
      throw new Error("Failed to set speaker tone", { cause: error });
    }
  }

  /**
   * Reset speaker settings to default (turn off speaker)
   */
  async resetSpeakerSettings() {
    try {
      // Disable speaker tone first via feature report
      await this.sendFeatureReport(128, [6, 2, 0, 1, 0]);

      const { validFlag0 } = this.currentOutputState;
      const outputStruct = new DS5OutputStruct({
        ...this.currentOutputState,
        speakerVolume: 0,
        validFlag0: validFlag0 | DS5_VALID_FLAG0.SPEAKER_VOLUME | DS5_VALID_FLAG0.AUDIO_CONTROL,
      });
      // outputStruct.audioControl = 0x00;
      await this.sendOutputReport(outputStruct.pack(), 'stop speaker tone');
      outputStruct.validFlag0 &= ~(DS5_VALID_FLAG0.SPEAKER_VOLUME | DS5_VALID_FLAG0.AUDIO_CONTROL);

      // Update current state to reflect the changes
      this.updateCurrentOutputState(outputStruct);
    } catch (error) {
      throw new Error("Failed to reset speaker settings", { cause: error });
    }
  }

  /**
   * Set lightbar color
   * @param {number} red - Red component (0-255)
   * @param {number} green - Green component (0-255)
   * @param {number} blue - Blue component (0-255)
   */
  async setLightbarColor(red = 0, green = 0, blue = 0) {
    try {
      const { validFlag1 } = this.currentOutputState;
      const outputStruct = new DS5OutputStruct({
        ...this.currentOutputState,
        ledCRed: Math.max(0, Math.min(255, red)),
        ledCGreen: Math.max(0, Math.min(255, green)),
        ledCBlue: Math.max(0, Math.min(255, blue)),
        validFlag1: validFlag1 | DS5_VALID_FLAG1.LIGHTBAR_COLOR,
      });
      await this.sendOutputReport(outputStruct.pack(), 'set lightbar color');
      outputStruct.validFlag1 &= ~DS5_VALID_FLAG1.LIGHTBAR_COLOR;

      // Update current state to reflect the changes
      this.updateCurrentOutputState(outputStruct);
    } catch (error) {
      throw new Error("Failed to set lightbar color", { cause: error });
    }
  }

  /**
   * Set player indicator lights
   * @param {number} pattern - Player indicator pattern (0-31, each bit represents a light)
   */
  async setPlayerIndicator(pattern = 0) {
    try {
      const { validFlag1 } = this.currentOutputState;
      const outputStruct = new DS5OutputStruct({
        ...this.currentOutputState,
        playerIndicator: Math.max(0, Math.min(31, pattern)),
        validFlag1: validFlag1 | DS5_VALID_FLAG1.PLAYER_INDICATOR,
      });
      await this.sendOutputReport(outputStruct.pack(), 'set player indicator');
      outputStruct.validFlag1 &= ~DS5_VALID_FLAG1.PLAYER_INDICATOR;

      // Update current state to reflect the changes
      this.updateCurrentOutputState(outputStruct);
    } catch (error) {
      throw new Error("Failed to set player indicator", { cause: error });
    }
  }

  /**
   * Reset lights to default state (turn off)
   */
  async resetLights() {
    try {
      await this.setLightbarColor(0, 0, 0);
      await this.setPlayerIndicator(0);
      await this.setMuteLed(0);
    } catch (error) {
      throw new Error("Failed to reset lights", { cause: error });
    }
  }

  /**
   * Set mute button LED state
   * @param {number} state - Mute LED state (0 = off, 1 = solid, 2 = pulsing)
   */
  async setMuteLed(state = 0) {
    try {
      const { validFlag1 } = this.currentOutputState;
      const outputStruct = new DS5OutputStruct({
        ...this.currentOutputState,
        muteLedControl: Math.max(0, Math.min(2, state)),
        validFlag1: validFlag1 | DS5_VALID_FLAG1.MUTE_LED,
      });
      await this.sendOutputReport(outputStruct.pack(), 'set mute LED');
      outputStruct.validFlag1 &= ~DS5_VALID_FLAG1.MUTE_LED;

      // Update current state to reflect the changes
      this.updateCurrentOutputState(outputStruct);
    } catch (error) {
      throw new Error("Failed to set mute LED", { cause: error });
    }
  }

  getNumberOfSticks() {
    return 2;
  }

  /**
  * Parse DS5 battery status from input data
  */
  parseBatteryStatus(data) {
    const bat = data.getUint8(52); // DS5 battery byte is at position 52

    // DS5: bat_charge = low 4 bits, bat_status = high 4 bits
    const bat_charge = bat & 0x0f;
    const bat_status = bat >> 4;

    let charge_level = 0;
    let cable_connected = false;
    let is_charging = false;
    let is_error = false;

    switch (bat_status) {
      case 0:
        // On battery power
        charge_level = Math.min(bat_charge * 10 + 5, 100);
        break;
      case 1:
        // Charging
        charge_level = Math.min(bat_charge * 10 + 5, 100);
        is_charging = true;
        cable_connected = true;
        break;
      case 2:
        // Fully charged
        charge_level = 100;
        cable_connected = true;
        break;
      case 15:
        // Battery is flat
        charge_level = 0;
        is_charging = true;
        cable_connected = true;
        break;
      case 11: // not sure yet what this error means
      default:
        // Error state
        is_error = true;
        break;
    }

    return { charge_level, cable_connected, is_charging, is_error };
  }
}

export default DS5Controller;
