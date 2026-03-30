/* ═══════════════════════════════════════════════════════════════════════════════
 * DICOM Handler — Lightweight Index & Hierarchical Sort
 * ═══════════════════════════════════════════════════════════════════════════════
 * Phase 1: Scan directories with unsorted DICOM data, build a lightweight index
 *          using smart heuristics (file size, naming, folder grouping) to avoid
 *          opening every file. Export to JSON / XLSX.
 * Phase 2: Sort data into a clean folder hierarchy:
 *          Patient / Study / CT → RTSTRUCT → RTPLAN
 *
 * Runs entirely in-browser via File System Access API.
 * Uses batching, streaming writes, and memory-conscious patterns to prevent OOM.
 * ═══════════════════════════════════════════════════════════════════════════════ */

(() => {
    'use strict';

    // ─────────────────────────────────────────────────────────────────────────
    // TAG DICTIONARY
    // ─────────────────────────────────────────────────────────────────────────

    // Comprehensive DICOM tag catalog — searchable by name, group, keyword.
    // hex uses the format xGGGGEEEE (group, element).
    // `cat` = display category for grouping in UI.
    const TAG_CATALOG = [
        // ── Meta ──────────────────────────────────────────────────────
        { key: 'TransferSyntaxUID',       hex: 'x00020010', cat: 'Meta',         kw: 'transfer syntax encoding' },
        { key: 'MediaStorageSOPClassUID',  hex: 'x00020002', cat: 'Meta',         kw: 'media storage SOP class' },
        // ── Patient ──────────────────────────────────────────────────
        { key: 'PatientName',             hex: 'x00100010', cat: 'Patient',      kw: 'patient name' },
        { key: 'PatientID',               hex: 'x00100020', cat: 'Patient',      kw: 'patient id identifier MRN' },
        { key: 'PatientBirthDate',        hex: 'x00100030', cat: 'Patient',      kw: 'patient birth date DOB' },
        { key: 'PatientSex',              hex: 'x00100040', cat: 'Patient',      kw: 'patient sex gender' },
        { key: 'PatientAge',              hex: 'x00101010', cat: 'Patient',      kw: 'patient age' },
        { key: 'PatientWeight',           hex: 'x00101030', cat: 'Patient',      kw: 'patient weight kg' },
        { key: 'PatientSize',             hex: 'x00101020', cat: 'Patient',      kw: 'patient height size' },
        { key: 'EthnicGroup',             hex: 'x00102160', cat: 'Patient',      kw: 'ethnic group ethnicity' },
        { key: 'PatientComments',         hex: 'x00104000', cat: 'Patient',      kw: 'patient comments' },
        { key: 'OtherPatientIDs',         hex: 'x00101000', cat: 'Patient',      kw: 'other patient ids' },
        // ── Study ────────────────────────────────────────────────────
        { key: 'StudyDate',               hex: 'x00080020', cat: 'Study',        kw: 'study date' },
        { key: 'StudyTime',               hex: 'x00080030', cat: 'Study',        kw: 'study time' },
        { key: 'AccessionNumber',         hex: 'x00080050', cat: 'Study',        kw: 'accession number' },
        { key: 'StudyDescription',        hex: 'x00081030', cat: 'Study',        kw: 'study description' },
        { key: 'StudyInstanceUID',        hex: 'x0020000d', cat: 'Study',        kw: 'study instance UID' },
        { key: 'StudyID',                 hex: 'x00200010', cat: 'Study',        kw: 'study id' },
        { key: 'ReferringPhysicianName',  hex: 'x00080090', cat: 'Study',        kw: 'referring physician name doctor' },
        { key: 'NameOfPhysiciansReadingStudy', hex: 'x00081060', cat: 'Study',   kw: 'reading physician radiologist' },
        { key: 'AdmittingDiagnosesDescription', hex: 'x00081080', cat: 'Study',  kw: 'admitting diagnosis' },
        // ── Series ───────────────────────────────────────────────────
        { key: 'Modality',                hex: 'x00080060', cat: 'Series',       kw: 'modality CT MR PT' },
        { key: 'SeriesDate',              hex: 'x00080021', cat: 'Series',       kw: 'series date' },
        { key: 'SeriesTime',              hex: 'x00080031', cat: 'Series',       kw: 'series time' },
        { key: 'SeriesDescription',       hex: 'x0008103e', cat: 'Series',       kw: 'series description protocol' },
        { key: 'SeriesInstanceUID',       hex: 'x0020000e', cat: 'Series',       kw: 'series instance UID' },
        { key: 'SeriesNumber',            hex: 'x00200011', cat: 'Series',       kw: 'series number' },
        { key: 'BodyPartExamined',        hex: 'x00180015', cat: 'Series',       kw: 'body part anatomy region' },
        { key: 'PatientPosition',         hex: 'x00185100', cat: 'Series',       kw: 'patient position HFS FFS' },
        { key: 'Laterality',              hex: 'x00200060', cat: 'Series',       kw: 'laterality left right' },
        { key: 'ProtocolName',            hex: 'x00181030', cat: 'Series',       kw: 'protocol name' },
        { key: 'OperatorsName',           hex: 'x00081070', cat: 'Series',       kw: 'operator technologist' },
        { key: 'PerformingPhysicianName', hex: 'x00081050', cat: 'Series',       kw: 'performing physician' },
        // ── Equipment ────────────────────────────────────────────────
        { key: 'Manufacturer',            hex: 'x00080070', cat: 'Equipment',    kw: 'manufacturer vendor' },
        { key: 'InstitutionName',         hex: 'x00080080', cat: 'Equipment',    kw: 'institution hospital' },
        { key: 'InstitutionAddress',      hex: 'x00080081', cat: 'Equipment',    kw: 'institution address' },
        { key: 'StationName',             hex: 'x00081010', cat: 'Equipment',    kw: 'station name scanner' },
        { key: 'ManufacturerModelName',   hex: 'x00081090', cat: 'Equipment',    kw: 'model name device' },
        { key: 'DeviceSerialNumber',      hex: 'x00181000', cat: 'Equipment',    kw: 'device serial number' },
        { key: 'SoftwareVersions',        hex: 'x00181020', cat: 'Equipment',    kw: 'software version' },
        // ── Instance / SOP ───────────────────────────────────────────
        { key: 'SOPClassUID',             hex: 'x00080016', cat: 'SOP',          kw: 'SOP class UID' },
        { key: 'SOPInstanceUID',          hex: 'x00080018', cat: 'SOP',          kw: 'SOP instance UID' },
        { key: 'InstanceNumber',          hex: 'x00200013', cat: 'SOP',          kw: 'instance number slice' },
        { key: 'ContentDate',             hex: 'x00080023', cat: 'SOP',          kw: 'content date' },
        { key: 'ContentTime',             hex: 'x00080033', cat: 'SOP',          kw: 'content time' },
        { key: 'AcquisitionDate',         hex: 'x00080022', cat: 'SOP',          kw: 'acquisition date' },
        { key: 'AcquisitionTime',         hex: 'x00080032', cat: 'SOP',          kw: 'acquisition time' },
        { key: 'AcquisitionNumber',       hex: 'x00200012', cat: 'SOP',          kw: 'acquisition number' },
        // ── Frame of Reference ───────────────────────────────────────
        { key: 'FrameOfReferenceUID',     hex: 'x00200052', cat: 'Frame',        kw: 'frame of reference UID' },
        { key: 'PositionReferenceIndicator', hex: 'x00201040', cat: 'Frame',     kw: 'position reference indicator' },
        // ── Image Geometry ───────────────────────────────────────────
        { key: 'ImagePositionPatient',    hex: 'x00200032', cat: 'Geometry',     kw: 'image position patient xyz' },
        { key: 'ImageOrientationPatient', hex: 'x00200037', cat: 'Geometry',     kw: 'image orientation patient direction cosines' },
        { key: 'SliceLocation',           hex: 'x00201041', cat: 'Geometry',     kw: 'slice location z position' },
        { key: 'SliceThickness',          hex: 'x00180050', cat: 'Geometry',     kw: 'slice thickness mm' },
        { key: 'SpacingBetweenSlices',    hex: 'x00180088', cat: 'Geometry',     kw: 'spacing between slices gap' },
        { key: 'PixelSpacing',            hex: 'x00280030', cat: 'Geometry',     kw: 'pixel spacing resolution mm' },
        // ── Pixel Data ───────────────────────────────────────────────
        { key: 'Rows',                    hex: 'x00280010', cat: 'Pixel',        kw: 'rows matrix height' },
        { key: 'Columns',                 hex: 'x00280011', cat: 'Pixel',        kw: 'columns matrix width' },
        { key: 'BitsAllocated',           hex: 'x00280100', cat: 'Pixel',        kw: 'bits allocated depth' },
        { key: 'BitsStored',              hex: 'x00280101', cat: 'Pixel',        kw: 'bits stored' },
        { key: 'HighBit',                 hex: 'x00280102', cat: 'Pixel',        kw: 'high bit' },
        { key: 'PixelRepresentation',     hex: 'x00280103', cat: 'Pixel',        kw: 'pixel representation signed unsigned' },
        { key: 'SamplesPerPixel',         hex: 'x00280002', cat: 'Pixel',        kw: 'samples per pixel color' },
        { key: 'PhotometricInterpretation', hex: 'x00280004', cat: 'Pixel',      kw: 'photometric monochrome RGB' },
        { key: 'RescaleIntercept',        hex: 'x00281052', cat: 'Pixel',        kw: 'rescale intercept HU' },
        { key: 'RescaleSlope',            hex: 'x00281053', cat: 'Pixel',        kw: 'rescale slope HU' },
        { key: 'RescaleType',             hex: 'x00281054', cat: 'Pixel',        kw: 'rescale type HU' },
        { key: 'WindowCenter',            hex: 'x00281050', cat: 'Pixel',        kw: 'window center level' },
        { key: 'WindowWidth',             hex: 'x00281051', cat: 'Pixel',        kw: 'window width' },
        // ── CT-specific ──────────────────────────────────────────────
        { key: 'KVP',                     hex: 'x00180060', cat: 'CT',           kw: 'tube voltage kVp kilovolt' },
        { key: 'XRayTubeCurrent',         hex: 'x00181151', cat: 'CT',           kw: 'tube current mA milliampere' },
        { key: 'Exposure',                hex: 'x00181152', cat: 'CT',           kw: 'exposure mAs' },
        { key: 'ExposureTime',            hex: 'x00181150', cat: 'CT',           kw: 'exposure time ms' },
        { key: 'ConvolutionKernel',       hex: 'x00181210', cat: 'CT',           kw: 'convolution kernel filter reconstruction' },
        { key: 'FilterType',              hex: 'x00181160', cat: 'CT',           kw: 'filter type' },
        { key: 'GeneratorPower',          hex: 'x00181170', cat: 'CT',           kw: 'generator power kW' },
        { key: 'FocalSpots',              hex: 'x00181190', cat: 'CT',           kw: 'focal spot size' },
        { key: 'DataCollectionDiameter',  hex: 'x00180090', cat: 'CT',           kw: 'scan field of view diameter' },
        { key: 'ReconstructionDiameter',  hex: 'x00181100', cat: 'CT',           kw: 'reconstruction diameter FOV' },
        { key: 'DistanceSourceToDetector', hex: 'x00181110', cat: 'CT',          kw: 'source to detector distance SDD' },
        { key: 'DistanceSourceToPatient', hex: 'x00181111', cat: 'CT',           kw: 'source to patient distance' },
        { key: 'GantryDetectorTilt',      hex: 'x00181120', cat: 'CT',           kw: 'gantry tilt angle' },
        { key: 'TableHeight',             hex: 'x00181130', cat: 'CT',           kw: 'table height couch' },
        { key: 'RotationDirection',       hex: 'x00181140', cat: 'CT',           kw: 'rotation direction CW CCW' },
        { key: 'RevolutionTime',          hex: 'x00189305', cat: 'CT',           kw: 'revolution rotation time' },
        { key: 'SingleCollimationWidth',  hex: 'x00189306', cat: 'CT',           kw: 'single collimation width' },
        { key: 'TotalCollimationWidth',   hex: 'x00189307', cat: 'CT',           kw: 'total collimation width' },
        { key: 'SpiralPitchFactor',       hex: 'x00189311', cat: 'CT',           kw: 'spiral pitch factor helical' },
        { key: 'CTDIvol',                 hex: 'x00189345', cat: 'CT',           kw: 'CTDIvol dose index volume' },
        // ── MR-specific ──────────────────────────────────────────────
        { key: 'MagneticFieldStrength',   hex: 'x00180087', cat: 'MR',           kw: 'magnetic field strength tesla' },
        { key: 'RepetitionTime',          hex: 'x00180080', cat: 'MR',           kw: 'repetition time TR ms' },
        { key: 'EchoTime',               hex: 'x00180081', cat: 'MR',           kw: 'echo time TE ms' },
        { key: 'InversionTime',           hex: 'x00180082', cat: 'MR',           kw: 'inversion time TI ms' },
        { key: 'FlipAngle',               hex: 'x00181314', cat: 'MR',           kw: 'flip angle FA degrees' },
        { key: 'ImagingFrequency',        hex: 'x00180084', cat: 'MR',           kw: 'imaging frequency MHz' },
        { key: 'NumberOfAverages',        hex: 'x00180083', cat: 'MR',           kw: 'number of averages NEX NSA' },
        { key: 'EchoTrainLength',         hex: 'x00180091', cat: 'MR',           kw: 'echo train length ETL turbo factor' },
        { key: 'PercentSampling',         hex: 'x00180093', cat: 'MR',           kw: 'percent sampling phase' },
        { key: 'PercentPhaseFieldOfView', hex: 'x00180094', cat: 'MR',           kw: 'percent phase FOV' },
        { key: 'MRAcquisitionType',       hex: 'x00180023', cat: 'MR',           kw: 'MR acquisition type 2D 3D' },
        { key: 'SequenceName',            hex: 'x00180024', cat: 'MR',           kw: 'sequence name pulse' },
        { key: 'ScanningSequence',        hex: 'x00180020', cat: 'MR',           kw: 'scanning sequence SE GE IR' },
        { key: 'SequenceVariant',         hex: 'x00180021', cat: 'MR',           kw: 'sequence variant SK SS MP' },
        { key: 'ScanOptions',             hex: 'x00180022', cat: 'MR',           kw: 'scan options SAT' },
        { key: 'ReceiveCoilName',         hex: 'x00181250', cat: 'MR',           kw: 'receive coil name' },
        { key: 'TransmitCoilName',        hex: 'x00181251', cat: 'MR',           kw: 'transmit coil body head' },
        { key: 'AcquisitionMatrix',       hex: 'x00181310', cat: 'MR',           kw: 'acquisition matrix frequency phase' },
        { key: 'SAR',                     hex: 'x00181316', cat: 'MR',           kw: 'SAR specific absorption rate' },
        { key: 'dBdt',                    hex: 'x00181318', cat: 'MR',           kw: 'dB/dt gradient' },
        // ── PET-specific ─────────────────────────────────────────────
        { key: 'Units',                   hex: 'x00541001', cat: 'PET',          kw: 'units BQML SUV' },
        { key: 'CountsSource',            hex: 'x00541002', cat: 'PET',          kw: 'counts source' },
        { key: 'DecayCorrection',         hex: 'x00541102', cat: 'PET',          kw: 'decay correction start admin' },
        { key: 'AttenuationCorrectionMethod', hex: 'x00541101', cat: 'PET',      kw: 'attenuation correction method' },
        { key: 'ReconstructionMethod',    hex: 'x00541103', cat: 'PET',          kw: 'reconstruction method algorithm OSEM' },
        { key: 'ScatterCorrectionMethod', hex: 'x00541105', cat: 'PET',          kw: 'scatter correction method' },
        { key: 'RadiopharmaceuticalInformationSequence', hex: 'x00540016', cat: 'PET', kw: 'radiopharmaceutical tracer FDG' },
        { key: 'Radiopharmaceutical',     hex: 'x00180031', cat: 'PET',          kw: 'radiopharmaceutical tracer name' },
        { key: 'RadionuclideTotalDose',   hex: 'x00181074', cat: 'PET',          kw: 'radionuclide total injected dose MBq' },
        { key: 'RadionuclideHalfLife',    hex: 'x00181075', cat: 'PET',          kw: 'radionuclide half life seconds' },
        // ── RT Structure Set ─────────────────────────────────────────
        { key: 'StructureSetLabel',       hex: 'x30060002', cat: 'RTSTRUCT',     kw: 'structure set label name' },
        { key: 'StructureSetName',        hex: 'x30060004', cat: 'RTSTRUCT',     kw: 'structure set name' },
        { key: 'StructureSetDate',        hex: 'x30060008', cat: 'RTSTRUCT',     kw: 'structure set date' },
        { key: 'StructureSetTime',        hex: 'x30060009', cat: 'RTSTRUCT',     kw: 'structure set time' },
        { key: 'ReferencedFrameOfReferenceSequence', hex: 'x30060010', cat: 'RTSTRUCT', kw: 'referenced frame reference' },
        // ── RT Plan ──────────────────────────────────────────────────
        { key: 'RTPlanLabel',             hex: 'x300a0002', cat: 'RTPLAN',       kw: 'RT plan label name' },
        { key: 'RTPlanName',              hex: 'x300a0003', cat: 'RTPLAN',       kw: 'RT plan name' },
        { key: 'RTPlanDate',              hex: 'x300a0006', cat: 'RTPLAN',       kw: 'RT plan date' },
        { key: 'RTPlanTime',              hex: 'x300a0007', cat: 'RTPLAN',       kw: 'RT plan time' },
        { key: 'PlanIntent',              hex: 'x300a000a', cat: 'RTPLAN',       kw: 'plan intent curative palliative' },
        { key: 'RTPlanGeometry',          hex: 'x300a000c', cat: 'RTPLAN',       kw: 'plan geometry' },
        { key: 'FractionGroupSequence',   hex: 'x300a0070', cat: 'RTPLAN',       kw: 'fraction group fractions' },
        { key: 'NumberOfFractionsPlanned', hex: 'x300a0078', cat: 'RTPLAN',      kw: 'number fractions planned' },
        { key: 'BeamSequence',            hex: 'x300a00b0', cat: 'RTPLAN',       kw: 'beam sequence fields' },
        { key: 'NumberOfBeams',           hex: 'x300a0080', cat: 'RTPLAN',       kw: 'number of beams fields' },
        // ── RT Dose ──────────────────────────────────────────────────
        { key: 'DoseUnits',               hex: 'x30040002', cat: 'RTDOSE',       kw: 'dose units Gy cGy' },
        { key: 'DoseType',                hex: 'x30040004', cat: 'RTDOSE',       kw: 'dose type physical effective' },
        { key: 'DoseSummationType',       hex: 'x3004000a', cat: 'RTDOSE',       kw: 'dose summation type plan beam' },
        { key: 'DoseGridScaling',         hex: 'x3004000e', cat: 'RTDOSE',       kw: 'dose grid scaling factor' },
        { key: 'DoseComment',             hex: 'x30040006', cat: 'RTDOSE',       kw: 'dose comment' },
        // ── Contrast / Agent ─────────────────────────────────────────
        { key: 'ContrastBolusAgent',      hex: 'x00180010', cat: 'Contrast',     kw: 'contrast agent bolus' },
        { key: 'ContrastBolusRoute',      hex: 'x00180014', cat: 'Contrast',     kw: 'contrast route IV oral' },
        { key: 'ContrastBolusTotalDose',  hex: 'x00181044', cat: 'Contrast',     kw: 'contrast dose total ml' },
        { key: 'ContrastBolusStartTime',  hex: 'x00181042', cat: 'Contrast',     kw: 'contrast start time injection' },
        // ── Image ────────────────────────────────────────────────────
        { key: 'ImageType',               hex: 'x00080008', cat: 'Image',        kw: 'image type ORIGINAL DERIVED PRIMARY' },
        { key: 'LossyImageCompression',   hex: 'x00282110', cat: 'Image',        kw: 'lossy compression' },
        { key: 'LossyImageCompressionRatio', hex: 'x00282112', cat: 'Image',     kw: 'lossy compression ratio' },
        { key: 'PresentationLUTShape',    hex: 'x20500020', cat: 'Image',        kw: 'presentation LUT shape identity inverse' },
        { key: 'BurnedInAnnotation',      hex: 'x00280301', cat: 'Image',        kw: 'burned in annotation overlay YES NO' },
    ];

    // Quick-lookup hex by key name
    const TAG = {};
    for (const t of TAG_CATALOG) TAG[t.key] = t.hex;

    // Core tags always extracted
    const CORE_TAGS = [
        'TransferSyntaxUID', 'SOPClassUID', 'SOPInstanceUID',
        'StudyDate', 'StudyTime', 'AccessionNumber', 'Modality',
        'Manufacturer', 'InstitutionName',
        'StudyDescription', 'SeriesDescription',
        'PatientName', 'PatientID', 'PatientBirthDate', 'PatientSex',
        'StudyInstanceUID', 'SeriesInstanceUID',
        'SeriesNumber', 'InstanceNumber', 'FrameOfReferenceUID',
    ];

    // Optional tags per modality
    const MODALITY_OPTIONAL = {
        CT:       ['SliceThickness', 'KVP', 'ConvolutionKernel', 'Rows', 'Columns',
                   'PixelSpacing', 'BitsAllocated', 'WindowCenter', 'WindowWidth',
                   'ImagePositionPatient'],
        MR:       ['MagneticFieldStrength', 'EchoTime', 'RepetitionTime', 'FlipAngle',
                   'Rows', 'Columns', 'PixelSpacing', 'SliceThickness'],
        PT:       ['Units', 'Rows', 'Columns', 'SliceThickness'],
        RTSTRUCT: ['StructureSetLabel', 'StructureSetName'],
        RTPLAN:   ['RTPlanLabel', 'RTPlanName', 'PlanIntent'],
        RTDOSE:   ['DoseUnits', 'DoseType', 'DoseSummationType'],
    };
    // Snapshot of built-in tags so we know which ones are removable
    const MODALITY_ORIGINAL = {};
    for (const [mod, tags] of Object.entries(MODALITY_OPTIONAL)) {
        MODALITY_ORIGINAL[mod] = new Set(tags);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // HEURISTIC CONSTANTS
    // ─────────────────────────────────────────────────────────────────────────

    const H = {
        HEADER_BYTES:        65536,       // read first 64 KB for tag extraction
        HEADER_BYTES_LARGE:  512 * 1024,  // 512 KB for RT-type files with large sequences
        SERIES_MIN_FILES:    10,          // min files to consider a likely imaging series
        SAMPLE_COUNT:        3,           // parse this many files per sampled series
        SIZE_SIM_RATIO:      0.30,        // within 30 % of median → similar
        CT_SIZE_MIN:         100 * 1024,  // 100 KB
        CT_SIZE_MAX:         2 * 1024 * 1024, // 2 MB
        MAX_FULL_READ:       50 * 1024 * 1024, // 50 MB
        BATCH_DEFAULT:       50,
        SORT_BATCH:          20,
    };

    // File-name patterns that hint at modality
    const NAME_HINTS = {
        CT:       /^ct/i,
        MR:       /^mr/i,
        RTSTRUCT: /^(rs|rtstruct)/i,
        RTPLAN:   /^(rp|rtplan)/i,
        RTDOSE:   /^(rd|rtdose)/i,
        PT:       /^(pt|pet)/i,
    };

    // ─────────────────────────────────────────────────────────────────────────
    // STATE
    // ─────────────────────────────────────────────────────────────────────────

    let sourceDirHandle = null;
    let targetDirHandle = null;
    let currentIndex = null;
    let fileHandleMap = null;        // Map<relativePath, FileSystemFileHandle>
    let abortController = null;
    let sortAborted = false;
    let sortPaused = false;

    // ─────────────────────────────────────────────────────────────────────────
    // DOM CACHE
    // ─────────────────────────────────────────────────────────────────────────

    const el = {};
    const EL_IDS = [
        'dicomSelectDir', 'dicomDirInfo', 'dicomDirName',
        'dicomScanBtn', 'dicomAbortBtn',
        'dicomSmartScan', 'dicomBatchSize',
        'dicomProgress', 'dicomProgressBar', 'dicomProgressText', 'dicomProgressDetail',
        'dicomStats', 'dicomPatientCount', 'dicomStudyCount', 'dicomSeriesCount',
        'dicomFileCount', 'dicomParsedCount', 'dicomSkippedCount',
        'dicomResults', 'dicomResultsBody', 'dicomModalityFilters',
        'dicomExportJSON', 'dicomExportXLSX', 'dicomExportRobocopy',
        'dicomSortSection', 'dicomSelectTargetDir', 'dicomTargetInfo', 'dicomTargetDirName',
        'dicomSortBtn', 'dicomSortProgress', 'dicomSortProgressBar', 'dicomSortProgressText',
        'dicomSortLog', 'dicomOptionalTagsPanel', 'dicomSettingsBody', 'dicomSettingsToggle',
        'dicomHierarchyMode',
        'dicomTestMode', 'dicomTestModeOpts', 'dicomMaxIndex', 'dicomMaxSort',
        'dicomProgressETA', 'dicomSortProgressETA',
        'dicomSortModFilters', 'dicomRequireComplete', 'dicomRequiredMods',
        'dicomSortPauseBtn', 'dicomSortAbortBtn',
        'dicomSortErrors', 'dicomSortErrorsSummary', 'dicomSortErrorsBody',
        'dicomApiCheck',
    ];

    function cacheElements() {
        EL_IDS.forEach(id => { el[id] = document.getElementById(id); });
    }

    // ─────────────────────────────────────────────────────────────────────────
    // UTILITIES
    // ─────────────────────────────────────────────────────────────────────────

    const sleep = ms => new Promise(r => setTimeout(r, ms));

    function sanitize(name) {
        return (name || 'unknown').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/_+/g, '_').trim() || 'unknown';
    }

    function fmtDate(d) {
        if (!d || d.length < 8) return d || '';
        return d.slice(0, 4) + '-' + d.slice(4, 6) + '-' + d.slice(6, 8);
    }

    function fmtSize(b) {
        if (b < 1024) return b + ' B';
        if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
        if (b < 1073741824) return (b / 1048576).toFixed(1) + ' MB';
        return (b / 1073741824).toFixed(2) + ' GB';
    }

    function escHtml(s) {
        const d = document.createElement('div');
        d.textContent = s || '';
        return d.innerHTML;
    }

    function median(arr) {
        const s = [...arr].sort((a, b) => a - b);
        const m = s.length >> 1;
        return s.length & 1 ? s[m] : (s[m - 1] + s[m]) / 2;
    }

    function sampleIndices(len, count) {
        if (len <= count) return Array.from({ length: len }, (_, i) => i);
        const step = len / (count + 1);
        return Array.from({ length: count }, (_, i) => Math.floor(step * (i + 1)));
    }

    // ─────────────────────────────────────────────────────────────────────────
    // LIGHTWEIGHT DICOM HEADER PARSER
    // ─────────────────────────────────────────────────────────────────────────
    // Handles Explicit VR LE and Implicit VR LE (covers 99 %+ of real files).
    // Reads only the tags we request; stops at pixel data or undefined-length
    // sequences. No external library needed.

    function parseDicomHeader(buffer, requestedKeys) {
        const len = buffer.byteLength;
        if (len < 132) return null;

        const view = new DataView(buffer);
        const u8 = new Uint8Array(buffer);

        // DICM magic at byte 128
        if (u8[128] !== 0x44 || u8[129] !== 0x49 ||
            u8[130] !== 0x43 || u8[131] !== 0x4D) return null;

        const decoder = new TextDecoder('latin1');
        const raw = {};               // tagHex → string value
        let pos = 132;
        let explicitVR = true;         // meta header always explicit VR LE
        let inMeta = true;

        // Set of hex tag IDs we want
        const wantHex = new Set();
        // Always read TransferSyntaxUID even if not explicitly requested
        wantHex.add(TAG.TransferSyntaxUID);
        for (const key of requestedKeys) {
            if (TAG[key]) wantHex.add(TAG[key]);
        }
        let found = 0;

        const LONG_VR = new Set([
            'OB', 'OD', 'OF', 'OL', 'OW', 'SQ', 'UC', 'UN', 'UR', 'UT',
        ]);

        while (pos + 4 <= len) {
            const group   = view.getUint16(pos, true);
            const element = view.getUint16(pos + 2, true);

            // Transition out of meta header
            if (inMeta && group > 0x0002) {
                inMeta = false;
                const ts = raw[TAG.TransferSyntaxUID] || '';
                if (ts === '1.2.840.10008.1.2') explicitVR = false;
                // Compressed & deflated TS still have explicit VR tags before pixel data
            }

            // Stop at pixel data
            if (group === 0x7FE0 && element === 0x0010) break;

            const tagHex = 'x' + group.toString(16).padStart(4, '0') +
                                  element.toString(16).padStart(4, '0');

            let valueLen = 0;

            if (explicitVR || inMeta) {
                if (pos + 6 > len) break;
                const vr = String.fromCharCode(u8[pos + 4], u8[pos + 5]);
                if (LONG_VR.has(vr)) {
                    if (pos + 12 > len) break;
                    valueLen = view.getUint32(pos + 8, true);
                    pos += 12;
                } else {
                    if (pos + 8 > len) break;
                    valueLen = view.getUint16(pos + 6, true);
                    pos += 8;
                }
            } else {
                if (pos + 8 > len) break;
                valueLen = view.getUint32(pos + 4, true);
                pos += 8;
            }

            // Undefined length (sequence) → skip over it by scanning for
            // the sequence delimitation item (FFFE,E00D) for items or
            // (FFFE,E0DD) for the sequence itself.
            if (valueLen === 0xFFFFFFFF) {
                // Skip nested sequence: look for Sequence Delimitation tag
                let depth = 1;
                while (pos + 8 <= len && depth > 0) {
                    const g = view.getUint16(pos, true);
                    const e = view.getUint16(pos + 2, true);
                    if (g === 0xFFFE && e === 0xE0DD) {
                        // Sequence Delimitation Item — skip its 4-byte zero length
                        pos += 8;
                        depth--;
                    } else if (g === 0xFFFE && (e === 0xE000 || e === 0xE00D)) {
                        // Item or Item Delimitation — skip tag + 4-byte length
                        const itemLen = view.getUint32(pos + 4, true);
                        pos += 8;
                        if (itemLen !== 0xFFFFFFFF && itemLen > 0) pos += itemLen;
                    } else {
                        // Inside sequence item — skip one element
                        pos += 4;
                        if (explicitVR || inMeta) {
                            if (pos + 2 > len) break;
                            const vr2 = String.fromCharCode(u8[pos], u8[pos + 1]);
                            if (LONG_VR.has(vr2)) {
                                if (pos + 8 > len) break;
                                const vl = view.getUint32(pos + 4, true);
                                pos += 8;
                                if (vl !== 0xFFFFFFFF) pos += vl;
                            } else {
                                if (pos + 4 > len) break;
                                const vl = view.getUint16(pos + 2, true);
                                pos += 4;
                                pos += vl;
                            }
                        } else {
                            if (pos + 4 > len) break;
                            const vl = view.getUint32(pos, true);
                            pos += 4;
                            if (vl !== 0xFFFFFFFF) pos += vl;
                        }
                    }
                }
                continue;
            }

            if (wantHex.has(tagHex) && valueLen > 0 && pos + valueLen <= len) {
                raw[tagHex] = decoder.decode(new Uint8Array(buffer, pos, valueLen))
                                     .replace(/\0/g, '').trim();
                found++;
                if (found >= wantHex.size) { pos += valueLen; break; }
            }

            pos += valueLen;
            if (pos & 1) pos++;       // even alignment safety
        }

        // Map back to friendly names
        const result = {};
        for (const key of requestedKeys) {
            const hex = TAG[key];
            if (hex && raw[hex] !== undefined) result[key] = raw[hex];
        }
        return Object.keys(result).length > 0 ? result : null;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // FILE SYSTEM WALKING
    // ─────────────────────────────────────────────────────────────────────────

    async function collectFiles(dirHandle, onProgress, signal, maxFiles) {
        const files = [];
        const dirGroups = new Map();   // dirPath → [entry]
        fileHandleMap = new Map();
        let count = 0;
        const cap = maxFiles || Infinity;

        async function walk(handle, path) {
            if (signal && signal.aborted) return;
            if (files.length >= cap) return;
            const children = [];
            for await (const entry of handle.values()) {
                if (signal && signal.aborted) return;
                children.push(entry);
            }

            const dirFiles = [];
            for (const child of children) {
                if (signal && signal.aborted) return;
                if (files.length >= cap) break;
                const childPath = path ? path + '/' + child.name : child.name;
                if (child.kind === 'directory') {
                    await walk(child, childPath);
                } else {
                    const file = await child.getFile();
                    const entry = {
                        name: child.name, path: childPath,
                        dirPath: path, handle: child,
                        size: file.size, lastModified: file.lastModified,
                    };
                    files.push(entry);
                    dirFiles.push(entry);
                    fileHandleMap.set(childPath, child);
                    if (++count % 200 === 0) {
                        onProgress('Scanning files: ' + count + ' found…' +
                            (cap < Infinity ? ' (test mode: max ' + cap + ')' : ''));
                        await sleep(0);
                    }
                }
            }
            if (dirFiles.length > 0) dirGroups.set(path, dirFiles);
        }

        await walk(dirHandle, '');
        return { files, dirGroups };
    }

    // ─────────────────────────────────────────────────────────────────────────
    // HEURISTIC CLASSIFIER
    // ─────────────────────────────────────────────────────────────────────────

    function looksLikeDicom(f) {
        const n = f.name.toLowerCase();
        if (/\.(dcm|dicom|dic)$/i.test(n)) return true;
        if (!n.includes('.') && f.size > 1024) return true;
        if (/^(ct|mr|rs|rp|rd|pt|rtst|rtpl|rtdo|rtim|img|im)\d*/i.test(n)) return true;
        if (/^\d+$/.test(n.split('.')[0]) && f.size > 1024) return true;
        if (/\.(txt|csv|json|xml|html|js|css|pdf|doc|docx|xlsx|xls|zip|rar|7z|tar|gz|exe|dll|jpg|jpeg|png|gif|bmp|tiff|tif|mp4|avi|log|ini|cfg|bat|sh|py|md|yaml|yml)$/i.test(n)) return false;
        return f.size > 1024;
    }

    function guessModality(name) {
        for (const [mod, rx] of Object.entries(NAME_HINTS)) {
            if (rx.test(name)) return mod;
        }
        return null;
    }

    function classifyGroups(dirGroups, smart) {
        const toParse = [];
        const toSample = [];    // { allFiles, sampleFiles, restFiles }
        const toSkip = [];

        for (const [, files] of dirGroups) {
            const cands = files.filter(looksLikeDicom);
            toSkip.push(...files.filter(f => !looksLikeDicom(f)));
            if (!cands.length) continue;

            if (!smart) { toParse.push(...cands); continue; }

            // Check for imaging-series pattern: many similarly-sized files
            if (cands.length >= H.SERIES_MIN_FILES) {
                const sizes = cands.map(f => f.size);
                const med = median(sizes);
                const thresh = med * H.SIZE_SIM_RATIO;
                const similar = cands.filter(f => Math.abs(f.size - med) < thresh);

                if (similar.length >= H.SERIES_MIN_FILES &&
                    med >= H.CT_SIZE_MIN && med <= H.CT_SIZE_MAX) {
                    const si = sampleIndices(similar.length, H.SAMPLE_COUNT);
                    toSample.push({
                        allFiles:    similar,
                        sampleFiles: si.map(i => similar[i]),
                        restFiles:   similar.filter((_, i) => !si.includes(i)),
                    });
                    // Outliers in same folder (e.g. RTSTRUCT among CT slices)
                    toParse.push(...cands.filter(f => Math.abs(f.size - med) >= thresh));
                    continue;
                }
            }

            // Group by guessed modality from file name
            const byMod = new Map();
            for (const f of cands) {
                const g = guessModality(f.name) || '_other';
                if (!byMod.has(g)) byMod.set(g, []);
                byMod.get(g).push(f);
            }
            for (const [mod, mf] of byMod) {
                if (['CT', 'MR', 'PT'].includes(mod) && mf.length >= H.SERIES_MIN_FILES) {
                    const si = sampleIndices(mf.length, H.SAMPLE_COUNT);
                    toSample.push({
                        allFiles:    mf,
                        sampleFiles: si.map(i => mf[i]),
                        restFiles:   mf.filter((_, i) => !si.includes(i)),
                    });
                } else {
                    toParse.push(...mf);
                }
            }
        }
        return { toParse, toSample, toSkip };
    }

    // ─────────────────────────────────────────────────────────────────────────
    // TAG READING (wrapper around the parser)
    // ─────────────────────────────────────────────────────────────────────────

    async function readTags(entry, keys) {
        const file = await entry.handle.getFile();
        // Use larger read for RT-type files which have big sequences before useful tags
        const isLargeHeader = /^(rs|rtstruct|rp|rtplan|rd|rtdose)/i.test(entry.name) ||
                              file.size > 1024 * 1024;
        const headerSize = isLargeHeader ? H.HEADER_BYTES_LARGE : H.HEADER_BYTES;
        const readSize = Math.min(file.size, headerSize);
        let buf = await file.slice(0, readSize).arrayBuffer();

        let result = parseDicomHeader(buf, keys);
        if ((!result || (!result.SeriesNumber && !result.SeriesDescription)) &&
            readSize < file.size && file.size <= H.MAX_FULL_READ) {
            // Header truncation or missing key tags — retry with full file
            buf = await file.arrayBuffer();
            result = parseDicomHeader(buf, keys);
        }
        buf = null;   // release for GC
        if (result) {
            result._filePath = entry.path;
            result._fileSize = entry.size;
        }
        return result;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // INDEXER  (Phase 1)
    // ─────────────────────────────────────────────────────────────────────────

    function allTagKeys() {
        const keys = [...CORE_TAGS];
        for (const arr of Object.values(MODALITY_OPTIONAL)) {
            for (const t of arr) { if (!keys.includes(t)) keys.push(t); }
        }
        return keys;
    }

    async function runIndex(dirHandle, opts) {
        const t0 = performance.now();
        abortController = new AbortController();
        const signal = abortController.signal;
        const maxFiles = opts.maxFiles || Infinity;

        // 1. Walk directory ─────────────────────────────────────────────
        uiProgress(0, 0, 'Scanning directory tree…');
        const { files, dirGroups } = await collectFiles(dirHandle, m => uiProgress(0, 0, m), signal, maxFiles);
        if (signal.aborted) return null;
        uiProgress(0, 0, `Found ${files.length} files in ${dirGroups.size} folders`);
        await sleep(50);

        // 2. Classify ───────────────────────────────────────────────────
        uiProgress(0, 0, 'Classifying files…');
        let { toParse, toSample, toSkip } = classifyGroups(dirGroups, opts.smartScan);

        // Apply test-mode cap
        if (maxFiles < Infinity) {
            toParse = toParse.slice(0, maxFiles);
            // Reduce inferred pool proportionally
            let remaining = maxFiles - toParse.length;
            if (remaining <= 0) {
                toSample = [];
            } else {
                const capped = [];
                for (const grp of toSample) {
                    if (remaining <= 0) break;
                    const take = Math.min(grp.sampleFiles.length, remaining);
                    capped.push({ ...grp, sampleFiles: grp.sampleFiles.slice(0, take) });
                    remaining -= take;
                }
                toSample = capped;
            }
        }

        const totalToParse = toParse.length +
                             toSample.reduce((s, g) => s + g.sampleFiles.length, 0);
        uiProgress(0, 0,
            `Will parse ${totalToParse} file(s)` +
            (toSample.length ? `, sampling ${toSample.length} series` : '') +
            `, skipping ${toSkip.length} non-DICOM` +
            (maxFiles < Infinity ? ` (test mode: max ${maxFiles})` : ''));
        await sleep(50);

        // 3. Parse ──────────────────────────────────────────────────────
        const tagKeys = allTagKeys();
        const parsed = [];
        let done = 0;
        const batchSize = opts.batchSize || H.BATCH_DEFAULT;

        for (let i = 0; i < toParse.length; i += batchSize) {
            if (signal.aborted) return null;
            const batch = toParse.slice(i, i + batchSize);
            for (const entry of batch) {
                if (signal.aborted) return null;
                parsed.push(await readTags(entry, tagKeys));
                done++;
                // Yield every file to keep UI responsive for abort
                if (done % 4 === 0) {
                    uiProgress(done, totalToParse, `Reading DICOM headers: ${done}/${totalToParse}`);
                    await sleep(0);
                }
            }
            uiProgress(done, totalToParse, `Reading DICOM headers: ${done}/${totalToParse}`);
            await sleep(0);
        }

        const inferred = [];
        for (const grp of toSample) {
            if (signal.aborted) return null;
            const results = [];
            for (const entry of grp.sampleFiles) {
                if (signal.aborted) return null;
                const r = await readTags(entry, tagKeys);
                results.push(r);
                parsed.push(r);
                done++;
                if (done % 4 === 0) await sleep(0);
            }
            uiProgress(done, totalToParse,
                `Reading DICOM headers: ${done}/${totalToParse} (inferred ${inferred.length} files)`);

            const sample = results.find(r => r && r.Modality);
            if (sample) {
                for (const rest of grp.restFiles) {
                    // Cap total indexed files (parsed + inferred) in test mode
                    if (maxFiles < Infinity && (parsed.filter(Boolean).length + inferred.length) >= maxFiles) break;
                    inferred.push({
                        ...sample,
                        _filePath: rest.path,
                        _fileSize: rest.size,
                        _inferred: true,
                        SOPInstanceUID: 'inferred-' + rest.path,
                        InstanceNumber: '',
                    });
                }
            }
            await sleep(0);
        }

        // 4. Build index ────────────────────────────────────────────────
        uiProgress(0, 0, 'Building index…');
        const allDicom = [...parsed.filter(Boolean), ...inferred];
        const index = buildIndex(allDicom, {
            sourcePath: dirHandle.name,
            totalFilesScanned: files.length,
            filesParsed: parsed.filter(Boolean).length,
            filesInferred: inferred.length,
            filesSkipped: toSkip.length + parsed.filter(r => !r).length,
            scanDurationMs: performance.now() - t0,
        });

        currentIndex = index;
        return index;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // INDEX CONSTRUCTION
    // ─────────────────────────────────────────────────────────────────────────

    function buildIndex(allFiles, meta) {
        const patients = {};
        const modSet = new Set();

        for (const f of allFiles) {
            if (!f) continue;
            const pid   = f.PatientID || 'UNKNOWN';
            const stUID = f.StudyInstanceUID || 'UNKNOWN_STUDY';
            const seUID = f.SeriesInstanceUID || 'UNKNOWN_SERIES';

            if (!patients[pid]) {
                patients[pid] = {
                    patientID: pid, patientName: f.PatientName || '',
                    patientBirthDate: f.PatientBirthDate || '',
                    patientSex: f.PatientSex || '', studies: {},
                };
            }
            const pat = patients[pid];
            if (!pat.studies[stUID]) {
                pat.studies[stUID] = {
                    studyInstanceUID: stUID, studyDate: f.StudyDate || '',
                    studyDescription: f.StudyDescription || '',
                    accessionNumber: f.AccessionNumber || '', series: {},
                };
            }
            const study = pat.studies[stUID];
            if (!study.series[seUID]) {
                const mod = f.Modality || 'UNKNOWN';
                modSet.add(mod);
                study.series[seUID] = {
                    seriesInstanceUID: seUID,
                    seriesNumber: f.SeriesNumber || '',
                    modality: mod,
                    seriesDescription: f.SeriesDescription || '',
                    frameOfReferenceUID: f.FrameOfReferenceUID || '',
                    manufacturer: f.Manufacturer || '',
                    institutionName: f.InstitutionName || '',
                    files: [], fileCount: 0, totalSize: 0,
                    optionalTags: {},
                };
                const opt = MODALITY_OPTIONAL[mod] || [];
                for (const k of opt) { if (f[k] !== undefined) study.series[seUID].optionalTags[k] = f[k]; }
            }
            const ser = study.series[seUID];
            ser.files.push({
                path: f._filePath, size: f._fileSize,
                instanceNumber: f.InstanceNumber || '',
                sopInstanceUID: f.SOPInstanceUID || '',
                inferred: !!f._inferred,
            });
            ser.fileCount++;
            ser.totalSize += f._fileSize || 0;
        }

        // Flat list for table / export
        const seriesList = [];
        for (const pat of Object.values(patients)) {
            for (const st of Object.values(pat.studies)) {
                for (const se of Object.values(st.series)) {
                    seriesList.push({
                        patientID: pat.patientID, patientName: pat.patientName,
                        studyDate: st.studyDate, studyDescription: st.studyDescription,
                        modality: se.modality, seriesNumber: se.seriesNumber,
                        seriesDescription: se.seriesDescription,
                        fileCount: se.fileCount, totalSize: se.totalSize,
                        frameOfReferenceUID: se.frameOfReferenceUID,
                        manufacturer: se.manufacturer,
                        institutionName: se.institutionName,
                        optionalTags: se.optionalTags,
                    });
                }
            }
        }

        return {
            scanInfo: {
                ...meta,
                scanDate: new Date().toISOString(),
                patientCount: Object.keys(patients).length,
                studyCount: Object.values(patients).reduce((s, p) => s + Object.keys(p.studies).length, 0),
                seriesCount: seriesList.length,
                fileCount: allFiles.length,
                modalities: [...modSet].sort(),
            },
            patients,
            seriesList,
        };
    }

    // ─────────────────────────────────────────────────────────────────────────
    // SORTER  (Phase 2)
    // ─────────────────────────────────────────────────────────────────────────

    function computeSortPlan(index, mode, excludedMods, requiredMods) {
        const plan = [];
        if (!mode) mode = 'nested';
        if (!excludedMods) excludedMods = new Set();

        for (const pat of Object.values(index.patients)) {
            // Check completeness: skip patient if required modalities not all present
            if (requiredMods && requiredMods.size) {
                const patMods = new Set();
                for (const st of Object.values(pat.studies)) {
                    for (const se of Object.values(st.series)) {
                        patMods.add(se.modality);
                    }
                }
                let complete = true;
                for (const rm of requiredMods) {
                    if (!patMods.has(rm)) { complete = false; break; }
                }
                if (!complete) continue;
            }

            const pFolder = sanitize(pat.patientID);
            for (const st of Object.values(pat.studies)) {
                const date = fmtDate(st.studyDate) || 'NoDate';
                const desc = sanitize(st.studyDescription || 'NoDescription');
                const stFolder = pFolder + '/' + date + '_' + desc;
                const allSeries = Object.values(st.series)
                    .filter(se => !excludedMods.has(se.modality));

                if (mode === 'modality') {
                    // Group by modality, then individual series inside
                    const byMod = new Map();
                    for (const se of allSeries) {
                        if (!byMod.has(se.modality)) byMod.set(se.modality, []);
                        byMod.get(se.modality).push(se);
                    }
                    for (const [mod, series] of byMod) {
                        for (const se of series) {
                            const label = sanitize(seriesLabel(se));
                            const folder = stFolder + '/' + mod + '/' + label;
                            addSeriesToPlan(plan, folder, se);
                        }
                    }
                } else if (mode === 'nested') {
                    // Nest RT objects under the primary imaging series in the study.
                    // First try grouping by FrameOfReferenceUID; if RT series have no
                    // FOR or a different FOR from the imaging, forcibly nest them under
                    // the primary imaging series anyway (they reference the same study).
                    const imaging = [];   // CT, MR, PT
                    const rtTypes = [];   // RTSTRUCT, RTPLAN, RTDOSE
                    const other   = [];
                    for (const se of allSeries) {
                        if (['CT', 'MR', 'PT'].includes(se.modality)) imaging.push(se);
                        else if (['RTSTRUCT', 'RTPLAN', 'RTDOSE'].includes(se.modality)) rtTypes.push(se);
                        else other.push(se);
                    }

                    if (imaging.length) {
                        // Pick the primary imaging series (most files, or first CT)
                        const primary = imaging.reduce((best, s) =>
                            s.fileCount > best.fileCount ? s : best, imaging[0]);
                        const pDir = stFolder + '/' + primary.modality + '_' +
                            sanitize(seriesLabel(primary));
                        addSeriesToPlan(plan, pDir, primary);

                        // Other imaging series as siblings
                        for (const se of imaging) {
                            if (se === primary) continue;
                            const folder = stFolder + '/' +
                                se.modality + '_' + sanitize(seriesLabel(se));
                            addSeriesToPlan(plan, folder, se);
                        }

                        // Nest RT under primary
                        const structs = rtTypes.filter(s => s.modality === 'RTSTRUCT');
                        const plans   = rtTypes.filter(s => s.modality === 'RTPLAN');
                        const doses   = rtTypes.filter(s => s.modality === 'RTDOSE');

                        for (const rs of structs) {
                            const rsDir = pDir + '/RTSTRUCT_' + sanitize(seriesLabel(rs));
                            addSeriesToPlan(plan, rsDir, rs);
                            for (const rp of plans) {
                                const rpDir = rsDir + '/RTPLAN_' + sanitize(seriesLabel(rp));
                                addSeriesToPlan(plan, rpDir, rp);
                            }
                        }
                        if (!structs.length) {
                            for (const rp of plans) {
                                const rpDir = pDir + '/RTPLAN_' + sanitize(seriesLabel(rp));
                                addSeriesToPlan(plan, rpDir, rp);
                            }
                        }
                        for (const rd of doses) {
                            const rdDir = pDir + '/RTDOSE_' + sanitize(seriesLabel(rd));
                            addSeriesToPlan(plan, rdDir, rd);
                        }
                    } else {
                        // No imaging — place everything flat
                        for (const se of [...rtTypes, ...other]) {
                            const folder = stFolder + '/' +
                                se.modality + '_' + sanitize(seriesLabel(se));
                            addSeriesToPlan(plan, folder, se);
                        }
                        other.length = 0; // already handled
                    }

                    // Other modalities as siblings
                    for (const se of other) {
                        const folder = stFolder + '/' +
                            se.modality + '_' + sanitize(seriesLabel(se));
                        addSeriesToPlan(plan, folder, se);
                    }
                } else {
                    // Flat — all modalities as siblings under study
                    const byFOR = new Map();
                    const noFOR = [];
                    for (const se of allSeries) {
                        const uid = se.frameOfReferenceUID;
                        if (uid) {
                            if (!byFOR.has(uid)) byFOR.set(uid, []);
                            byFOR.get(uid).push(se);
                        } else {
                            noFOR.push(se);
                        }
                    }
                    for (const group of byFOR.values()) {
                        addFlatGroupToPlan(plan, stFolder, group);
                    }
                    for (const se of noFOR) {
                        const folder = stFolder + '/' +
                            se.modality + '_' + sanitize(seriesLabel(se));
                        addSeriesToPlan(plan, folder, se);
                    }
                }
            }
        }
        return plan;
    }

    function seriesLabel(se) {
        if (se.modality === 'RTSTRUCT')
            return se.optionalTags.StructureSetLabel || se.seriesDescription || 'S' + se.seriesNumber;
        if (se.modality === 'RTPLAN')
            return se.optionalTags.RTPlanLabel || se.seriesDescription || 'S' + se.seriesNumber;
        if (se.modality === 'RTDOSE')
            return se.optionalTags.DoseType || se.seriesDescription || 'S' + se.seriesNumber;
        return se.seriesDescription || 'S' + se.seriesNumber;
    }

    function addNestedGroupToPlan(plan, base, group) {
        // Find the primary imaging series (CT/MR/PT)
        const primary = group.find(s => ['CT', 'MR', 'PT'].includes(s.modality));
        const structs = group.filter(s => s.modality === 'RTSTRUCT');
        const rtPlans = group.filter(s => s.modality === 'RTPLAN');
        const doses   = group.filter(s => s.modality === 'RTDOSE');
        const others  = group.filter(s =>
            !['CT', 'MR', 'PT', 'RTSTRUCT', 'RTPLAN', 'RTDOSE'].includes(s.modality));

        if (primary) {
            const pDir = base + '/' + primary.modality + '_' +
                sanitize(seriesLabel(primary));
            addSeriesToPlan(plan, pDir, primary);

            for (const rs of structs) {
                const rsDir = pDir + '/RTSTRUCT_' + sanitize(seriesLabel(rs));
                addSeriesToPlan(plan, rsDir, rs);
                // Nest plans under their struct
                for (const rp of rtPlans) {
                    const rpDir = rsDir + '/RTPLAN_' + sanitize(seriesLabel(rp));
                    addSeriesToPlan(plan, rpDir, rp);
                }
            }
            // Plans without a struct go directly under imaging
            if (!structs.length) {
                for (const rp of rtPlans) {
                    const rpDir = pDir + '/RTPLAN_' + sanitize(seriesLabel(rp));
                    addSeriesToPlan(plan, rpDir, rp);
                }
            }
            for (const rd of doses) {
                const rdDir = pDir + '/RTDOSE_' + sanitize(seriesLabel(rd));
                addSeriesToPlan(plan, rdDir, rd);
            }
            for (const o of others) {
                const oDir = pDir + '/' + o.modality + '_' + sanitize(seriesLabel(o));
                addSeriesToPlan(plan, oDir, o);
            }
        } else {
            // No primary imaging — fall back to flat
            for (const se of group) {
                const folder = base + '/' +
                    se.modality + '_' + sanitize(seriesLabel(se));
                addSeriesToPlan(plan, folder, se);
            }
        }
    }

    function addFlatGroupToPlan(plan, base, group) {
        for (const se of group) {
            const folder = base + '/' +
                se.modality + '_' + sanitize(seriesLabel(se));
            addSeriesToPlan(plan, folder, se);
        }
    }

    function addSeriesToPlan(plan, folder, series) {
        for (const f of series.files) {
            plan.push({
                src: f.path,
                dst: folder + '/' + f.path.split('/').pop(),
            });
        }
    }

    async function runSort(index, srcDir, dstDir, mode, onProgress, maxCopy, excludedMods, requiredMods) {
        // Safety: never write to the source directory
        if (await srcDir.isSameEntry(dstDir)) {
            throw new Error('Refusing to sort: output directory is the same as the source. Source files must not be modified.');
        }
        sortAborted = false;
        sortPaused = false;
        let plan = computeSortPlan(index, mode, excludedMods, requiredMods);
        if (maxCopy && maxCopy < plan.length) {
            plan = plan.slice(0, maxCopy);
        }
        const total = plan.length;
        let copied = 0, errors = 0;
        const log = [];
        const errorLog = [];
        const createdDirs = new Map();   // path → handle

        async function ensureDir(relPath) {
            if (createdDirs.has(relPath)) return createdDirs.get(relPath);
            const parts = relPath.split('/');
            let cur = dstDir;
            let built = '';
            for (const p of parts) {
                built = built ? built + '/' + p : p;
                if (createdDirs.has(built)) { cur = createdDirs.get(built); continue; }
                cur = await cur.getDirectoryHandle(p, { create: true });
                createdDirs.set(built, cur);
            }
            return cur;
        }

        for (let i = 0; i < plan.length; i += H.SORT_BATCH) {
            if (sortAborted) break;
            const batch = plan.slice(i, i + H.SORT_BATCH);
            for (const item of batch) {
                if (sortAborted) break;
                // Pause support — spin until resumed or aborted
                while (sortPaused && !sortAborted) {
                    await sleep(200);
                }
                if (sortAborted) break;
                try {
                    const parts = item.dst.split('/');
                    const fileName = parts.pop();
                    const dirPath = parts.join('/');
                    const dir = await ensureDir(dirPath);
                    const srcHandle = fileHandleMap.get(item.src);
                    if (!srcHandle) throw new Error('Source handle not found');
                    const srcFile = await srcHandle.getFile();
                    const dstFile = await dir.getFileHandle(fileName, { create: true });
                    const writable = await dstFile.createWritable();
                    // Stream the File blob directly — avoids loading entire file into memory
                    await writable.write(srcFile);
                    await writable.close();
                    copied++;
                    log.push('✓ ' + item.src + ' → ' + item.dst);
                } catch (e) {
                    errors++;
                    const msg = item.src + ': ' + e.message;
                    log.push('✗ ' + msg);
                    errorLog.push(msg);
                }
            }
            onProgress(copied, total, errors, log, errorLog);
            await sleep(0);
        }
        return { copied, errors, total, log, errorLog, aborted: sortAborted };
    }

    // ─────────────────────────────────────────────────────────────────────────
    // EXPORT
    // ─────────────────────────────────────────────────────────────────────────

    function exportJSON(index) {
        const out = { scanInfo: index.scanInfo, seriesList: index.seriesList, patients: {} };
        for (const [pid, pat] of Object.entries(index.patients)) {
            out.patients[pid] = { ...pat, studies: {} };
            for (const [sid, st] of Object.entries(pat.studies)) {
                out.patients[pid].studies[sid] = { ...st, series: {} };
                for (const [serid, se] of Object.entries(st.series)) {
                    out.patients[pid].studies[sid].series[serid] = {
                        ...se,
                        files: se.files.map(f => ({
                            path: f.path, size: f.size,
                            instanceNumber: f.instanceNumber, inferred: f.inferred,
                        })),
                    };
                }
            }
        }
        const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
        saveAs(blob, 'dicom-index-' + new Date().toISOString().slice(0, 10) + '.json');
    }

    function exportXLSX(index) {
        const wb = XLSX.utils.book_new();

        // Series sheet
        const rows = index.seriesList.map(s => {
            const row = {
                'Patient ID': s.patientID, 'Patient Name': s.patientName,
                'Study Date': fmtDate(s.studyDate), 'Study Description': s.studyDescription,
                'Modality': s.modality, 'Series #': s.seriesNumber,
                'Series Description': s.seriesDescription,
                'Files': s.fileCount, 'Size': fmtSize(s.totalSize),
                'Frame of Ref UID': s.frameOfReferenceUID,
                'Manufacturer': s.manufacturer,
                'Institution': s.institutionName,
            };
            for (const [k, v] of Object.entries(s.optionalTags || {})) row[k] = v;
            return row;
        });
        XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'Series Index');

        // Summary sheet
        const info = index.scanInfo;
        XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet([
            { Property: 'Source', Value: info.sourcePath },
            { Property: 'Scan Date', Value: info.scanDate },
            { Property: 'Total Files Scanned', Value: info.totalFilesScanned },
            { Property: 'DICOM Files Parsed', Value: info.filesParsed },
            { Property: 'Files Inferred (sampled)', Value: info.filesInferred },
            { Property: 'Files Skipped', Value: info.filesSkipped },
            { Property: 'Patients', Value: info.patientCount },
            { Property: 'Studies', Value: info.studyCount },
            { Property: 'Series', Value: info.seriesCount },
            { Property: 'Total DICOM Files', Value: info.fileCount },
            { Property: 'Modalities', Value: info.modalities.join(', ') },
            { Property: 'Duration', Value: (info.scanDurationMs / 1000).toFixed(1) + ' s' },
        ]), 'Scan Summary');

        // Files detail (capped at 100 k rows)
        const MAX = 100000;
        const fRows = [];
        for (const pat of Object.values(index.patients)) {
            for (const st of Object.values(pat.studies)) {
                for (const se of Object.values(st.series)) {
                    for (const file of se.files) {
                        if (fRows.length >= MAX) break;
                        fRows.push({
                            'Patient ID': pat.patientID,
                            'Study Date': fmtDate(st.studyDate),
                            'Modality': se.modality,
                            'Series Description': se.seriesDescription,
                            'Instance #': file.instanceNumber,
                            'File Path': file.path,
                            'Size': fmtSize(file.size),
                            'Inferred': file.inferred ? 'Yes' : '',
                        });
                    }
                }
            }
        }
        XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(fRows), 'Files Detail');

        XLSX.writeFile(wb, 'dicom-index-' + new Date().toISOString().slice(0, 10) + '.xlsx');
    }

    function exportRobocopyScript(index, mode, excludedMods, requiredMods) {
        const plan = computeSortPlan(index, mode, excludedMods, requiredMods);
        if (!plan.length) { alert('No files in sort plan. Check modality filters.'); return; }

        // Show path configuration dialog before generating script
        const srcName = index.scanInfo.sourcePath || '';
        showRobocopyDialog(srcName, plan, index, mode, excludedMods, requiredMods);
    }

    function showRobocopyDialog(srcName, plan, index, mode) {
        // Remove any existing dialog
        const existing = document.getElementById('dicomRobocopyDialog');
        if (existing) existing.remove();

        const totalFiles = plan.length;

        const backdrop = document.createElement('div');
        backdrop.id = 'dicomRobocopyDialog';
        backdrop.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;' +
            'background:rgba(0,0,0,0.5);z-index:10000;display:flex;align-items:center;' +
            'justify-content:center;backdrop-filter:blur(2px);';

        const dialog = document.createElement('div');
        dialog.style.cssText = 'background:var(--card-bg, #1e293b);color:var(--text, #e2e8f0);' +
            'border-radius:12px;padding:1.5rem;max-width:560px;width:90%;box-shadow:0 20px 60px rgba(0,0,0,0.5);' +
            'font-family:inherit;';

        dialog.innerHTML = `
            <h3 style="margin:0 0 0.25rem;color:#0891b2;font-size:1.1rem;">
                <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none"
                     stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
                     style="vertical-align:text-bottom;margin-right:0.3rem;">
                    <rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect>
                    <line x1="8" y1="21" x2="16" y2="21"></line><line x1="12" y1="17" x2="12" y2="21"></line>
                </svg>
                Robocopy Sort Script
            </h3>
            <p style="margin:0 0 1rem;font-size:0.85rem;color:#94a3b8;">
                ${totalFiles} files · ${index.scanInfo.patientCount} patients · ${mode} mode<br>
                Enter the full Windows/UNC paths. UNC paths are recommended for speed.
            </p>
            <label style="display:block;font-size:0.8rem;font-weight:600;margin-bottom:0.25rem;color:#cbd5e1;">
                Source path <span style="font-weight:400;color:#64748b;">(where the DICOM folder "${escHtml(srcName)}" lives)</span>
            </label>
            <input id="rcSrcPath" type="text" spellcheck="false"
                placeholder="e.g. \\\\server\\share\\path\\to\\${srcName}"
                style="width:100%;box-sizing:border-box;padding:0.5rem 0.6rem;border-radius:6px;border:1px solid #334155;
                       background:#0f172a;color:#e2e8f0;font-family:monospace;font-size:0.85rem;margin-bottom:0.75rem;"
                value="">
            <label style="display:block;font-size:0.8rem;font-weight:600;margin-bottom:0.25rem;color:#cbd5e1;">
                Destination path <span style="font-weight:400;color:#64748b;">(where sorted output goes)</span>
            </label>
            <input id="rcDstPath" type="text" spellcheck="false"
                placeholder="e.g. D:\\DICOM_Sorted  or  \\\\server\\output\\sorted"
                style="width:100%;box-sizing:border-box;padding:0.5rem 0.6rem;border-radius:6px;border:1px solid #334155;
                       background:#0f172a;color:#e2e8f0;font-family:monospace;font-size:0.85rem;margin-bottom:0.75rem;"
                value="">
            <div style="background:#0f172a;border-radius:6px;padding:0.6rem 0.75rem;margin-bottom:1rem;font-size:0.78rem;color:#94a3b8;">
                <strong style="color:#22d3ee;">Tip:</strong> UNC paths (\\\\server\\share) are faster than mounted drives
                for robocopy — it talks SMB directly without OS mount overhead.<br>
                You can also edit these paths in the downloaded .ps1 file later.
            </div>
            <div style="display:flex;gap:0.6rem;justify-content:flex-end;">
                <button id="rcCancel" style="padding:0.45rem 1rem;border-radius:6px;border:1px solid #334155;
                    background:transparent;color:#94a3b8;cursor:pointer;font-size:0.85rem;">Cancel</button>
                <button id="rcDownload" style="padding:0.45rem 1rem;border-radius:6px;border:none;
                    background:#0891b2;color:white;cursor:pointer;font-size:0.85rem;font-weight:600;">
                    Download Script</button>
            </div>`;

        backdrop.appendChild(dialog);
        document.body.appendChild(backdrop);

        // Close on backdrop click
        backdrop.addEventListener('click', (e) => { if (e.target === backdrop) backdrop.remove(); });
        dialog.querySelector('#rcCancel').addEventListener('click', () => backdrop.remove());

        // Focus source input
        const srcInput = dialog.querySelector('#rcSrcPath');
        const dstInput = dialog.querySelector('#rcDstPath');
        srcInput.focus();

        dialog.querySelector('#rcDownload').addEventListener('click', () => {
            const userSrc = srcInput.value.trim();
            const userDst = dstInput.value.trim();
            backdrop.remove();
            generateRobocopyFile(plan, index, mode, userSrc, userDst);
        });

        // Enter key in dest input triggers download
        dstInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') dialog.querySelector('#rcDownload').click();
        });
    }

    function generateRobocopyFile(plan, index, mode, userSrc, userDst) {
        // Group by (sourceDir → destDir) for efficient robocopy calls
        const groups = new Map();
        for (const item of plan) {
            const srcParts = item.src.split('/');
            const srcFile = srcParts.pop();
            const srcDir = srcParts.join('\\') || '.';
            const dstParts = item.dst.split('/');
            dstParts.pop();
            const dstDir = dstParts.join('\\');
            const key = srcDir + '|' + dstDir;
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(srcFile);
        }

        const totalFiles = plan.length;
        const totalGroups = groups.size;
        const srcName = index.scanInfo.sourcePath || 'SOURCE_FOLDER';
        const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');

        // Use user-provided paths or placeholders
        const scriptSrc = userSrc || srcName.replace(/\//g, '\\');
        const scriptDst = userDst || 'SET_OUTPUT_PATH_HERE';

        const lines = [];
        lines.push('#Requires -Version 5.1');
        lines.push('<#');
        lines.push('.SYNOPSIS');
        lines.push('    DICOM Robocopy Sort Script — generated by MedMod DICOM Indexer');
        lines.push('    Generated: ' + new Date().toISOString());
        lines.push('    Source scan: ' + srcName);
        lines.push('    Patients: ' + index.scanInfo.patientCount + '  |  Studies: ' + index.scanInfo.studyCount +
                   '  |  Series: ' + index.scanInfo.seriesCount + '  |  Files: ' + totalFiles);
        lines.push('    Sort mode: ' + mode);
        lines.push('');
        lines.push('.DESCRIPTION');
        lines.push('    This script copies DICOM files from a source directory to an organized');
        lines.push('    output structure using robocopy for maximum speed and reliability.');
        lines.push('    Files are COPIED (never moved or deleted). Source is never modified.');
        lines.push('');
        lines.push('.NOTES');
        lines.push('    - Review $SourceRoot and $DestRoot below before running');
        lines.push('    - Supports UNC paths (e.g. \\\\server\\share\\path)');
        lines.push('    - UNC paths are faster than mounted drives for robocopy');
        lines.push('    - Robocopy retries failed copies automatically (3 retries, 5s wait)');
        lines.push('    - A detailed log file is written next to this script');
        lines.push('    - Run as: .\\dicom-sort-' + stamp + '.ps1');
        lines.push('#>');
        lines.push('');
        lines.push('# ═══════════════════════════════════════════════════════════════════════');
        lines.push('# CONFIGURATION — Review these paths before running');
        lines.push('# ═══════════════════════════════════════════════════════════════════════');
        lines.push('');
        lines.push('$SourceRoot = "' + scriptSrc.replace(/"/g, '`"') + '"');
        lines.push('$DestRoot   = "' + scriptDst.replace(/"/g, '`"') + '"');
        lines.push('');
        lines.push('# Robocopy options (safe defaults — copy only, no delete, with retries)');
        lines.push('$RobocopyOpts = @(');
        lines.push('    "/COPY:DAT"    # Copy Data, Attributes, Timestamps');
        lines.push('    "/R:3"         # Retry 3 times on failure');
        lines.push('    "/W:5"         # Wait 5 seconds between retries');
        lines.push('    "/NP"          # No per-file progress (cleaner output)');
        lines.push('    "/NDL"         # No directory listing');
        lines.push('    "/NFL"         # No file listing (we log ourselves)');
        lines.push('    "/NJH"         # No job header');
        lines.push('    "/NJS"         # No job summary');
        lines.push(')');
        lines.push('');
        lines.push('# ═══════════════════════════════════════════════════════════════════════');
        lines.push('# SAFETY CHECKS — Do not modify below unless you know what you are doing');
        lines.push('# ═══════════════════════════════════════════════════════════════════════');
        lines.push('');
        lines.push('$ErrorActionPreference = "Stop"');
        lines.push('$LogFile = Join-Path $PSScriptRoot ("dicom-sort-log-" + (Get-Date -Format "yyyy-MM-dd-HHmmss") + ".txt")');
        lines.push('');
        lines.push('function Write-Log {');
        lines.push('    param([string]$Message, [string]$Level = "INFO")');
        lines.push('    $entry = "[$(Get-Date -Format \'yyyy-MM-dd HH:mm:ss\')] [$Level] $Message"');
        lines.push('    Add-Content -Path $LogFile -Value $entry');
        lines.push('    switch ($Level) {');
        lines.push('        "ERROR"   { Write-Host $entry -ForegroundColor Red }');
        lines.push('        "WARN"    { Write-Host $entry -ForegroundColor Yellow }');
        lines.push('        "SUCCESS" { Write-Host $entry -ForegroundColor Green }');
        lines.push('        default   { Write-Host $entry }');
        lines.push('    }');
        lines.push('}');
        lines.push('');
        lines.push('# Validate paths');
        lines.push('if ($DestRoot -eq "SET_OUTPUT_PATH_HERE" -or [string]::IsNullOrWhiteSpace($DestRoot)) {');
        lines.push('    Write-Host "" ');
        lines.push('    Write-Host "  ERROR: Destination path is not set." -ForegroundColor Red');
        lines.push('    Write-Host "  Open this .ps1 file in a text editor And set the $DestRoot variable." -ForegroundColor Yellow');
        lines.push('    Write-Host "" ');
        lines.push('    exit 1');
        lines.push('}');
        lines.push('');
        lines.push('if (-not (Test-Path $SourceRoot)) {');
        lines.push('    Write-Host "  ERROR: Source path not found: $SourceRoot" -ForegroundColor Red');
        lines.push('    Write-Host "  Check that the network share is accessible and the path is correct." -ForegroundColor Yellow');
        lines.push('    exit 1');
        lines.push('}');
        lines.push('');
        lines.push('# Resolve to full paths to prevent confusion');
        lines.push('$SourceRoot = (Resolve-Path $SourceRoot).Path.TrimEnd("\\")  ');
        lines.push('');
        lines.push('# Safety: source and dest must differ');
        lines.push('if ($SourceRoot -eq $DestRoot.TrimEnd("\\")) {');
        lines.push('    Write-Host "  ERROR: Source and destination are the same. Aborting." -ForegroundColor Red');
        lines.push('    exit 1');
        lines.push('}');
        lines.push('');
        lines.push('# ═══════════════════════════════════════════════════════════════════════');
        lines.push('# SUMMARY & CONFIRMATION');
        lines.push('# ═══════════════════════════════════════════════════════════════════════');
        lines.push('');
        lines.push('Write-Host ""');
        lines.push('Write-Host "  ╔══════════════════════════════════════════════════════════╗" -ForegroundColor Cyan');
        lines.push('Write-Host "  ║       DICOM Robocopy Sort Script — MedMod               ║" -ForegroundColor Cyan');
        lines.push('Write-Host "  ╚══════════════════════════════════════════════════════════╝" -ForegroundColor Cyan');
        lines.push('Write-Host ""');
        lines.push('Write-Host "  Source:       $SourceRoot" -ForegroundColor White');
        lines.push('Write-Host "  Destination:  $DestRoot" -ForegroundColor White');
        lines.push('Write-Host "  Total files:  ' + totalFiles + '" -ForegroundColor White');
        lines.push('Write-Host "  Folder groups: ' + totalGroups + '" -ForegroundColor White');
        lines.push('Write-Host "  Sort mode:    ' + mode + '" -ForegroundColor White');
        lines.push('Write-Host "  Log file:     $LogFile" -ForegroundColor White');
        lines.push('Write-Host ""');
        lines.push('Write-Host "  This script will COPY files. Source files are NEVER moved or deleted." -ForegroundColor Green');
        lines.push('Write-Host ""');
        lines.push('');
        lines.push('$confirm = Read-Host "  Proceed with copy? (yes/no)"');
        lines.push('if ($confirm -notin @("yes","y","Y","Yes","YES")) {');
        lines.push('    Write-Host "  Aborted by user." -ForegroundColor Yellow');
        lines.push('    exit 0');
        lines.push('}');
        lines.push('Write-Host ""');
        lines.push('');
        lines.push('Write-Log "Starting DICOM sort copy"');
        lines.push('Write-Log "Source: $SourceRoot"');
        lines.push('Write-Log "Destination: $DestRoot"');
        lines.push('Write-Log "Total files: ' + totalFiles + ', Groups: ' + totalGroups + ', Mode: ' + mode + '"');
        lines.push('');
        lines.push('# ═══════════════════════════════════════════════════════════════════════');
        lines.push('# COPY OPERATIONS');
        lines.push('# ═══════════════════════════════════════════════════════════════════════');
        lines.push('');
        lines.push('$copied = 0');
        lines.push('$errors = 0');
        lines.push('$groupNum = 0');
        lines.push('$totalFiles = ' + totalFiles);
        lines.push('$totalGroups = ' + totalGroups);
        lines.push('$stopwatch = [System.Diagnostics.Stopwatch]::StartNew()');
        lines.push('');

        // Emit one robocopy block per (srcDir, dstDir) group
        let groupIdx = 0;
        for (const [key, files] of groups) {
            groupIdx++;
            const [srcDir, dstDir] = key.split('|');
            const fileCount = files.length;

            lines.push('# ── Group ' + groupIdx + '/' + totalGroups + ' (' + fileCount + ' files) ──');
            lines.push('$groupNum++');
            lines.push('$srcDir = Join-Path $SourceRoot "' + srcDir + '"');
            lines.push('$dstDir = Join-Path $DestRoot "' + dstDir + '"');
            lines.push('');
            lines.push('# Create destination directory');
            lines.push('if (-not (Test-Path $dstDir)) {');
            lines.push('    New-Item -ItemType Directory -Path $dstDir -Force | Out-Null');
            lines.push('}');
            lines.push('');

            // Robocopy can accept multiple filenames in one call
            // Group into batches of ~50 files to avoid command-line length limits
            const BATCH = 50;
            for (let b = 0; b < files.length; b += BATCH) {
                const batch = files.slice(b, b + BATCH);
                const fileArgs = batch.map(f => '"' + f.replace(/"/g, '`"') + '"').join(' ');
                lines.push('$robocopyArgs = @($srcDir, $dstDir, ' +
                    batch.map(f => '"' + f.replace(/"/g, '`"') + '"').join(', ') +
                    ') + $RobocopyOpts');
                lines.push('$result = & robocopy @robocopyArgs 2>&1');
                lines.push('# Robocopy exit codes: 0=no copy needed, 1=copied OK, 2+=errors/extras');
                lines.push('if ($LASTEXITCODE -le 1) {');
                lines.push('    $copied += ' + batch.length);
                lines.push('} elseif ($LASTEXITCODE -le 3) {');
                lines.push('    # Some files copied, some extra — still OK');
                lines.push('    $copied += ' + batch.length);
                lines.push('} else {');
                lines.push('    $errors += ' + batch.length);
                lines.push('    Write-Log "Robocopy error (exit $LASTEXITCODE) in group $groupNum — src: $srcDir" "ERROR"');
                lines.push('    foreach ($line in $result) { Write-Log "  $line" "ERROR" }');
                lines.push('}');
                lines.push('');
            }

            // Progress update after each group
            lines.push('$pct = [math]::Round(($copied + $errors) / $totalFiles * 100)');
            lines.push('$elapsed = $stopwatch.Elapsed.ToString("hh\\:mm\\:ss")');
            lines.push('Write-Progress -Activity "DICOM Sort Copy" -Status "$copied / $totalFiles files ($pct%) — $elapsed elapsed" -PercentComplete $pct');
            lines.push('if ($groupNum % 10 -eq 0 -or $groupNum -eq $totalGroups) {');
            lines.push('    Write-Host "  [$elapsed] Group $groupNum/$totalGroups — $copied copied, $errors errors ($pct%)" -ForegroundColor Gray');
            lines.push('}');
            lines.push('');
        }

        // Summary
        lines.push('# ═══════════════════════════════════════════════════════════════════════');
        lines.push('# SUMMARY');
        lines.push('# ═══════════════════════════════════════════════════════════════════════');
        lines.push('');
        lines.push('$stopwatch.Stop()');
        lines.push('$duration = $stopwatch.Elapsed.ToString("hh\\:mm\\:ss")');
        lines.push('Write-Progress -Activity "DICOM Sort Copy" -Completed');
        lines.push('');
        lines.push('Write-Host ""');
        lines.push('Write-Host "  ╔══════════════════════════════════════════════════════════╗" -ForegroundColor Cyan');
        lines.push('Write-Host "  ║  COPY COMPLETE                                         ║" -ForegroundColor Cyan');
        lines.push('Write-Host "  ╚══════════════════════════════════════════════════════════╝" -ForegroundColor Cyan');
        lines.push('Write-Host ""');
        lines.push('Write-Host "  Files copied:  $copied / $totalFiles" -ForegroundColor Green');
        lines.push('Write-Host "  Errors:        $errors" -ForegroundColor $(if ($errors -gt 0) { "Red" } else { "Green" })');
        lines.push('Write-Host "  Duration:      $duration" -ForegroundColor White');
        lines.push('Write-Host "  Log file:      $LogFile" -ForegroundColor White');
        lines.push('Write-Host "  Destination:   $DestRoot" -ForegroundColor White');
        lines.push('Write-Host ""');
        lines.push('');
        lines.push('Write-Log "Copy complete — $copied copied, $errors errors in $duration" $(if ($errors -gt 0) { "WARN" } else { "SUCCESS" })');
        lines.push('');
        lines.push('if ($errors -gt 0) {');
        lines.push('    Write-Host "  WARNING: $errors file(s) failed to copy. Check the log file for details." -ForegroundColor Yellow');
        lines.push('    Write-Host "  You can re-run this script safely — robocopy will skip files already copied." -ForegroundColor Yellow');
        lines.push('    Write-Host ""');
        lines.push('}');
        lines.push('');
        lines.push('Read-Host "  Press Enter to close"');

        const script = lines.join('\r\n');
        const blob = new Blob([script], { type: 'text/plain;charset=utf-8' });
        saveAs(blob, 'dicom-sort-' + stamp + '.ps1');
    }

    // ─────────────────────────────────────────────────────────────────────────
    // UI HELPERS
    // ─────────────────────────────────────────────────────────────────────────

    function fmtETA(elapsedMs, done, total) {
        if (done <= 0 || total <= 0) return '';
        const remainMs = (elapsedMs / done) * (total - done);
        const speed = (done / (elapsedMs / 1000)).toFixed(0);
        if (remainMs < 1000) return speed + ' files/s — almost done';
        const secs = Math.ceil(remainMs / 1000);
        if (secs < 60) return speed + ' files/s — ~' + secs + 's remaining';
        const mins = Math.floor(secs / 60);
        const s = secs % 60;
        return speed + ' files/s — ~' + mins + 'm ' + (s > 0 ? s + 's' : '') + ' remaining';
    }

    function uiProgress(cur, total, msg) {
        if (!el.dicomProgress) return;
        el.dicomProgress.style.display = 'block';
        el.dicomProgressText.textContent = msg;
        if (total > 0) {
            const pct = Math.round(cur / total * 100);
            el.dicomProgressBar.style.width = pct + '%';
            el.dicomProgressDetail.textContent = pct + '%';
        } else {
            el.dicomProgressBar.style.width = '100%';
            el.dicomProgressBar.classList.add('indeterminate');
            el.dicomProgressDetail.textContent = '';
        }
    }

    function renderStats(idx) {
        el.dicomStats.style.display = 'grid';
        el.dicomPatientCount.textContent = idx.scanInfo.patientCount;
        el.dicomStudyCount.textContent   = idx.scanInfo.studyCount;
        el.dicomSeriesCount.textContent  = idx.scanInfo.seriesCount;
        el.dicomFileCount.textContent    = idx.scanInfo.fileCount;
        el.dicomParsedCount.textContent  = idx.scanInfo.filesParsed;
        el.dicomSkippedCount.textContent = idx.scanInfo.filesSkipped;
    }

    function renderModalityFilters(idx) {
        const c = el.dicomModalityFilters;
        c.innerHTML = '';
        const allBtn = Object.assign(document.createElement('button'), {
            className: 'dicom-mod-btn active', textContent: 'All',
        });
        allBtn.dataset.modality = 'all';
        c.appendChild(allBtn);
        for (const m of idx.scanInfo.modalities) {
            const b = Object.assign(document.createElement('button'), {
                className: 'dicom-mod-btn', textContent: m,
            });
            b.dataset.modality = m;
            const n = idx.seriesList.filter(s => s.modality === m).length;
            b.title = n + ' series';
            c.appendChild(b);
        }
        c.onclick = e => {
            const b = e.target.closest('.dicom-mod-btn');
            if (!b) return;
            c.querySelectorAll('.dicom-mod-btn').forEach(x => x.classList.remove('active'));
            b.classList.add('active');
            renderTable(idx.seriesList, b.dataset.modality);
        };
    }

    function renderTable(list, filter) {
        const tbody = el.dicomResultsBody;
        tbody.innerHTML = '';
        const items = (!filter || filter === 'all') ? list : list.filter(s => s.modality === filter);
        for (const s of items) {
            const tr = document.createElement('tr');
            tr.innerHTML =
                '<td>' + escHtml(s.patientID) + '</td>' +
                '<td>' + escHtml(s.patientName) + '</td>' +
                '<td>' + fmtDate(s.studyDate) + '</td>' +
                '<td><span class="dicom-badge dicom-badge-' + s.modality.toLowerCase() + '">' +
                    escHtml(s.modality) + '</span></td>' +
                '<td>' + escHtml(s.seriesDescription) + '</td>' +
                '<td class="num">' + s.fileCount + '</td>' +
                '<td class="num">' + fmtSize(s.totalSize) + '</td>';
            tbody.appendChild(tr);
        }
        el.dicomResults.style.display = 'block';
    }

    function renderSortModFilters(idx) {
        const mods = idx.scanInfo.modalities;
        // Include/exclude checkboxes
        const c = el.dicomSortModFilters;
        if (c) {
            c.innerHTML = '';
            for (const m of mods) {
                const lbl = document.createElement('label');
                lbl.className = 'dicom-sort-mod-cb';
                const cb = document.createElement('input');
                cb.type = 'checkbox'; cb.checked = true;
                cb.value = m; cb.dataset.sortmod = m;
                lbl.appendChild(cb);
                lbl.appendChild(document.createTextNode(' ' + m));
                c.appendChild(lbl);
            }
        }
        // Required modality checkboxes
        const r = el.dicomRequiredMods;
        if (r) {
            r.innerHTML = '';
            for (const m of mods) {
                const lbl = document.createElement('label');
                lbl.className = 'dicom-sort-mod-cb';
                const cb = document.createElement('input');
                cb.type = 'checkbox'; cb.checked = false;
                cb.value = m; cb.dataset.reqmod = m;
                lbl.appendChild(cb);
                lbl.appendChild(document.createTextNode(' ' + m));
                r.appendChild(lbl);
            }
        }
    }

    function getSortModExclusions() {
        const excluded = new Set();
        if (!el.dicomSortModFilters) return excluded;
        el.dicomSortModFilters.querySelectorAll('input[data-sortmod]').forEach(cb => {
            if (!cb.checked) excluded.add(cb.value);
        });
        return excluded;
    }

    function getRequiredModalities() {
        if (!el.dicomRequireComplete || !el.dicomRequireComplete.checked) return null;
        const req = new Set();
        if (!el.dicomRequiredMods) return null;
        el.dicomRequiredMods.querySelectorAll('input[data-reqmod]').forEach(cb => {
            if (cb.checked) req.add(cb.value);
        });
        return req.size ? req : null;
    }

    function renderOptionalTags() {
        const p = el.dicomOptionalTagsPanel;
        if (!p) return;

        // Build the panel HTML
        let h = '';

        // ── Header + controls ──
        h += '<div class="dtag-header">';
        h += '<div class="dtag-title-row">';
        h += '<h4 class="dtag-title">Optional DICOM Tags</h4>';
        h += '<div class="dtag-bulk-btns">';
        h += '<button type="button" class="dtag-link-btn" id="dtagSelectAll">Select all</button>';
        h += '<span class="dtag-sep">/</span>';
        h += '<button type="button" class="dtag-link-btn" id="dtagDeselectAll">Deselect all</button>';
        h += '</div></div>';
        h += '<p class="dtag-subtitle">Core IDs are always included. Add extra tags per modality below, or search the full DICOM dictionary.</p>';
        h += '</div>';

        // ── Search bar ──
        h += '<div class="dtag-search-wrap">';
        h += '<svg class="dtag-search-icon" xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>';
        h += '<input type="text" id="dtagSearch" class="dtag-search" placeholder="Search tags — e.g. slice, kVp, (0018,0050), coil, dose…">';
        h += '<kbd class="dtag-search-hint">name · keyword · group</kbd>';
        h += '</div>';
        h += '<div id="dtagSearchResults" class="dtag-search-results"></div>';

        // ── Per-modality groups ──
        const modColors = { CT: '#3b82f6', MR: '#8b5cf6', PT: '#f59e0b', RTSTRUCT: '#10b981', RTPLAN: '#ec4899', RTDOSE: '#ef4444' };
        for (const [mod, tags] of Object.entries(MODALITY_OPTIONAL)) {
            const color = modColors[mod] || '#64748b';
            h += '<div class="dtag-group" data-modality="' + mod + '">';
            h += '<div class="dtag-group-head">';
            h += '<span class="dtag-group-badge" style="background:' + color + '">' + mod + '</span>';
            h += '<span class="dtag-group-count" data-mod-count="' + mod + '">0/' + tags.length + '</span>';
            h += '</div>';
            h += '<div class="dtag-pills">';
            for (const t of tags) {
                const entry = TAG_CATALOG.find(c => c.key === t);
                const hex = entry ? entry.hex.replace('x', '(').replace(/(\w{4})(\w{4})/, '$1,$2)') : '';
                h += '<label class="dtag-pill" title="' + hex + ' — ' + (entry ? entry.kw : '') + '">';
                h += '<input type="checkbox" data-modality="' + mod + '" data-tag="' + t + '">';
                h += '<span class="dtag-pill-text">' + t + '</span>';
                h += '</label>';
            }
            h += '</div></div>';
        }

        p.innerHTML = h;

        // ── Wire search ──
        const searchInput = document.getElementById('dtagSearch');
        const resultsBox  = document.getElementById('dtagSearchResults');
        let debounce = null;

        searchInput.addEventListener('input', () => {
            clearTimeout(debounce);
            debounce = setTimeout(() => renderSearchResults(searchInput.value.trim(), resultsBox), 120);
        });
        searchInput.addEventListener('focus', () => {
            if (searchInput.value.trim()) renderSearchResults(searchInput.value.trim(), resultsBox);
        });
        document.addEventListener('click', e => {
            if (!p.contains(e.target)) resultsBox.innerHTML = '';
        });

        // ── Wire select / deselect all ──
        document.getElementById('dtagSelectAll').addEventListener('click', () => {
            p.querySelectorAll('.dtag-pill input[type=checkbox]').forEach(cb => {
                cb.checked = true;
                cb.closest('.dtag-pill').classList.add('checked');
            });
            updateGroupCounts(p);
        });
        document.getElementById('dtagDeselectAll').addEventListener('click', () => {
            p.querySelectorAll('.dtag-pill input[type=checkbox]').forEach(cb => {
                cb.checked = false;
                cb.closest('.dtag-pill').classList.remove('checked');
            });
            updateGroupCounts(p);
        });

        // ── Wire checkbox pill toggle ──
        p.addEventListener('change', e => {
            const cb = e.target;
            if (cb.type !== 'checkbox') return;
            const pill = cb.closest('.dtag-pill');
            if (pill) pill.classList.toggle('checked', cb.checked);
            updateGroupCounts(p);
        });

        // ── Wire remove (×) button on dynamically added pills ──
        p.addEventListener('click', e => {
            const btn = e.target.closest('.dtag-pill-remove');
            if (!btn) return;
            const pill = btn.closest('.dtag-pill');
            if (!pill) return;
            const cb = pill.querySelector('input[type=checkbox]');
            if (!cb) return;
            const mod = cb.dataset.modality;
            const key = cb.dataset.tag;
            // Remove from runtime list
            const idx = MODALITY_OPTIONAL[mod]?.indexOf(key);
            if (idx > -1) MODALITY_OPTIONAL[mod].splice(idx, 1);
            pill.remove();
            updateGroupCounts(p);
            // Reset any open search result button for this mod+key
            const resultsBox = document.getElementById('dtagSearchResults');
            if (resultsBox) {
                const addBtn = resultsBox.querySelector('.dtag-sr-add[data-addmod="' + mod + '"][data-addkey="' + key + '"]');
                if (addBtn) {
                    addBtn.classList.remove('added');
                    addBtn.textContent = '+ ' + mod;
                }
            }
        });
    }

    function updateGroupCounts(panel) {
        for (const [mod] of Object.entries(MODALITY_OPTIONAL)) {
            const cbs = panel.querySelectorAll('.dtag-pill input[data-modality="' + mod + '"]');
            const on  = [...cbs].filter(c => c.checked).length;
            const el  = panel.querySelector('[data-mod-count="' + mod + '"]');
            if (el) el.textContent = on + '/' + cbs.length;
        }
    }

    function renderSearchResults(query, box) {
        if (!query) { box.innerHTML = ''; return; }
        const q = query.toLowerCase().replace(/[()\s,]/g, '');
        const matches = TAG_CATALOG.filter(t => {
            const haystack = (t.key + ' ' + t.hex + ' ' + t.cat + ' ' + t.kw).toLowerCase().replace(/[()\s,]/g, '');
            return haystack.includes(q);
        });

        // Exclude tags already shown as core
        const coreSet = new Set(CORE_TAGS);
        const filtered = matches.filter(t => !coreSet.has(t.key)).slice(0, 25);

        if (!filtered.length) {
            box.innerHTML = '<div class="dtag-sr-empty">No matching tags found</div>';
            return;
        }

        let h = '';
        for (const t of filtered) {
            const hex = t.hex.replace('x', '(').replace(/(\w{4})(\w{4})/, '$1,$2)');
            // Check which modalities already have this tag
            const inMods = [];
            for (const [mod, tags] of Object.entries(MODALITY_OPTIONAL)) {
                if (tags.includes(t.key)) inMods.push(mod);
            }
            h += '<div class="dtag-sr-row" data-key="' + t.key + '">';
            h += '<div class="dtag-sr-info">';
            h += '<span class="dtag-sr-name">' + t.key + '</span>';
            h += '<span class="dtag-sr-hex">' + hex + '</span>';
            h += '<span class="dtag-sr-cat">' + t.cat + '</span>';
            if (inMods.length) h += '<span class="dtag-sr-in">' + inMods.join(', ') + '</span>';
            h += '</div>';
            h += '<div class="dtag-sr-kw">' + t.kw + '</div>';
            h += '<div class="dtag-sr-actions">';
            for (const mod of Object.keys(MODALITY_OPTIONAL)) {
                const cls = inMods.includes(mod) ? 'dtag-sr-add added' : 'dtag-sr-add';
                h += '<button type="button" class="' + cls + '" data-addmod="' + mod + '" data-addkey="' + t.key + '" title="Add to ' + mod + '">+ ' + mod + '</button>';
            }
            h += '</div></div>';
        }

        box.innerHTML = h;

        // Handle "add" clicks
        box.querySelectorAll('.dtag-sr-add').forEach(btn => {
            btn.addEventListener('click', () => {
                if (btn.classList.contains('added')) return;
                const mod = btn.dataset.addmod;
                const key = btn.dataset.addkey;
                if (!MODALITY_OPTIONAL[mod].includes(key)) {
                    MODALITY_OPTIONAL[mod].push(key);
                    // Make sure TAG has the hex
                    const cat = TAG_CATALOG.find(t => t.key === key);
                    if (cat && !TAG[key]) TAG[key] = cat.hex;
                }
                btn.classList.add('added');
                btn.textContent = '✓ ' + mod;
                // Add a new pill to the group
                const group = el.dicomOptionalTagsPanel.querySelector('.dtag-group[data-modality="' + mod + '"] .dtag-pills');
                if (group && !group.querySelector('input[data-tag="' + key + '"]')) {
                    const entry = TAG_CATALOG.find(c => c.key === key);
                    const hex = entry ? entry.hex.replace('x', '(').replace(/(\w{4})(\w{4})/, '$1,$2)') : '';
                    const lbl = document.createElement('label');
                    lbl.className = 'dtag-pill checked dtag-pill-new';
                    lbl.title = hex + ' — ' + (entry ? entry.kw : '');
                    lbl.innerHTML = '<input type="checkbox" data-modality="' + mod + '" data-tag="' + key + '" checked>' +
                                   '<span class="dtag-pill-text">' + key + '</span>' +
                                   '<span class="dtag-pill-remove" title="Remove">×</span>';
                    group.appendChild(lbl);
                    requestAnimationFrame(() => lbl.classList.remove('dtag-pill-new'));
                }
                updateGroupCounts(el.dicomOptionalTagsPanel);
            });
        });
    }

    function renderSortPreview(plan) {
        // Build tree
        const tree = {};
        for (const item of plan) {
            const parts = item.dst.split('/');
            let node = tree;
            for (let i = 0; i < parts.length - 1; i++) {
                if (!node[parts[i]]) node[parts[i]] = {};
                node = node[parts[i]];
            }
            node._files = (node._files || 0) + 1;
        }
        function render(obj, depth) {
            let out = '';
            for (const [k, v] of Object.entries(obj)) {
                if (k === '_files') {
                    out += '<div style="padding-left:' + (depth * 1.2) + 'rem" class="dicom-tree-files">' + v + ' file(s)</div>';
                } else {
                    out += '<div style="padding-left:' + (depth * 1.2) + 'rem" class="dicom-tree-dir">📁 ' + escHtml(k) + '</div>';
                    out += render(v, depth + 1);
                }
            }
            return out;
        }
        el.dicomSortLog.innerHTML = '<h4>Proposed Structure</h4>' + render(tree, 0);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // EVENT WIRING
    // ─────────────────────────────────────────────────────────────────────────

    function setup() {
        // Check API support
        if (!window.showDirectoryPicker) {
            if (el.dicomApiCheck) el.dicomApiCheck.style.display = 'block';
            return;
        }

        // Select source directory  (READ-ONLY — source files are never modified)
        el.dicomSelectDir.addEventListener('click', async () => {
            try {
                sourceDirHandle = await window.showDirectoryPicker({ mode: 'read' });
                el.dicomDirInfo.style.display = 'flex';
                el.dicomDirName.textContent = sourceDirHandle.name;
                el.dicomScanBtn.disabled = false;
            } catch (e) { if (e.name !== 'AbortError') console.error(e); }
        });

        // Scan
        el.dicomScanBtn.addEventListener('click', async () => {
            if (!sourceDirHandle) return;
            el.dicomScanBtn.disabled = true;
            el.dicomAbortBtn.style.display = 'inline-flex';
            el.dicomResults.style.display = 'none';
            el.dicomStats.style.display = 'none';
            el.dicomSortSection.style.display = 'none';
            el.dicomProgressBar.classList.remove('indeterminate');
            try {
                const idx = await runIndex(sourceDirHandle, {
                    smartScan: el.dicomSmartScan ? el.dicomSmartScan.checked : true,
                    batchSize: parseInt(el.dicomBatchSize?.value) || H.BATCH_DEFAULT,
                    maxFiles: el.dicomTestMode.checked ? (parseInt(el.dicomMaxIndex?.value) || 50) : Infinity,
                });
                if (idx) {
                    el.dicomProgressBar.classList.remove('indeterminate');
                    renderStats(idx);
                    renderModalityFilters(idx);
                    renderSortModFilters(idx);
                    renderTable(idx.seriesList);
                    el.dicomSortSection.style.display = 'block';
                    el.dicomExportJSON.disabled = false;
                    el.dicomExportXLSX.disabled = false;
                    if (el.dicomExportRobocopy) el.dicomExportRobocopy.disabled = false;
                    uiProgress(1, 1,
                        'Done — ' + idx.scanInfo.fileCount + ' DICOM files, ' +
                        idx.scanInfo.patientCount + ' patients in ' +
                        (idx.scanInfo.scanDurationMs / 1000).toFixed(1) + ' s');
                    if (el.dicomProgressETA) el.dicomProgressETA.textContent = '';
                }
            } catch (e) {
                console.error('Scan error', e);
                uiProgress(0, 0, 'Error: ' + e.message);
            } finally {
                el.dicomScanBtn.disabled = false;
                el.dicomAbortBtn.style.display = 'none';
            }
        });

        // Abort
        el.dicomAbortBtn.addEventListener('click', () => {
            if (abortController) abortController.abort();
        });

        // Export
        el.dicomExportJSON.addEventListener('click', () => { if (currentIndex) exportJSON(currentIndex); });
        el.dicomExportXLSX.addEventListener('click', () => { if (currentIndex) exportXLSX(currentIndex); });
        if (el.dicomExportRobocopy) el.dicomExportRobocopy.addEventListener('click', () => {
            if (currentIndex) exportRobocopyScript(currentIndex, el.dicomHierarchyMode.value,
                getSortModExclusions(), getRequiredModalities());
        });

        // Settings toggle
        el.dicomSettingsToggle?.addEventListener('click', () => {
            const body = el.dicomSettingsBody;
            const open = body.style.display !== 'none';
            body.style.display = open ? 'none' : 'block';
            el.dicomSettingsToggle.textContent = open ? '▶' : '▼';
        });

        // Test mode toggle
        el.dicomTestMode?.addEventListener('change', () => {
            el.dicomTestModeOpts.style.display = el.dicomTestMode.checked ? 'flex' : 'none';
        });

        // Target directory (must differ from source)
        el.dicomSelectTargetDir.addEventListener('click', async () => {
            try {
                const picked = await window.showDirectoryPicker({ mode: 'readwrite' });
                // Guard: never allow writing into the source directory
                if (sourceDirHandle && await sourceDirHandle.isSameEntry(picked)) {
                    alert('Output directory must be different from the source directory. Source files must never be modified.');
                    return;
                }
                targetDirHandle = picked;
                el.dicomTargetInfo.style.display = 'flex';
                el.dicomTargetDirName.textContent = targetDirHandle.name;
                el.dicomSortBtn.disabled = false;
                if (currentIndex) renderSortPreview(computeSortPlan(currentIndex, el.dicomHierarchyMode.value,
                    getSortModExclusions(), getRequiredModalities()));
            } catch (e) { if (e.name !== 'AbortError') console.error(e); }
        });

        // Hierarchy mode change → update preview
        el.dicomHierarchyMode.addEventListener('change', () => {
            if (currentIndex && targetDirHandle) {
                renderSortPreview(computeSortPlan(currentIndex, el.dicomHierarchyMode.value,
                    getSortModExclusions(), getRequiredModalities()));
            }
        });

        // Sort pause/abort
        el.dicomSortPauseBtn?.addEventListener('click', () => {
            sortPaused = !sortPaused;
            el.dicomSortPauseBtn.textContent = sortPaused ? 'Resume' : 'Pause';
            el.dicomSortPauseBtn.classList.toggle('btn-success', sortPaused);
            el.dicomSortPauseBtn.classList.toggle('btn-warning', !sortPaused);
        });
        el.dicomSortAbortBtn?.addEventListener('click', () => {
            sortAborted = true;
            sortPaused = false;
        });

        // Sort
        el.dicomSortBtn.addEventListener('click', async () => {
            if (!currentIndex || !sourceDirHandle || !targetDirHandle) return;
            el.dicomSortBtn.disabled = true;
            el.dicomSortProgress.style.display = 'block';
            el.dicomSortPauseBtn.style.display = 'inline-flex';
            el.dicomSortAbortBtn.style.display = 'inline-flex';
            el.dicomSortPauseBtn.textContent = 'Pause';
            el.dicomSortPauseBtn.classList.add('btn-warning');
            el.dicomSortPauseBtn.classList.remove('btn-success');
            // Reset collapsible errors
            if (el.dicomSortErrors) { el.dicomSortErrors.style.display = 'none'; }
            if (el.dicomSortErrorsBody) { el.dicomSortErrorsBody.innerHTML = ''; }
            if (el.dicomSortErrorsSummary) { el.dicomSortErrorsSummary.textContent = 'Errors (0)'; }
            try {
                const maxCopy = el.dicomTestMode.checked ? (parseInt(el.dicomMaxSort?.value) || 20) : 0;
                const excludedMods = getSortModExclusions();
                const requiredMods = getRequiredModalities();
                const sortStart = performance.now();
                const res = await runSort(currentIndex, sourceDirHandle, targetDirHandle,
                    el.dicomHierarchyMode.value,
                    (copied, total, errors, log, errorLog) => {
                        const pct = Math.round(copied / total * 100);
                        el.dicomSortProgressBar.style.width = pct + '%';
                        el.dicomSortProgressText.textContent =
                            'Copying: ' + copied + '/' + total + ' (' + pct + '%, ' + errors + ' errors)' +
                            (maxCopy ? ' [test mode]' : '');
                        const elapsed = performance.now() - sortStart;
                        if (el.dicomSortProgressETA) {
                            el.dicomSortProgressETA.textContent = fmtETA(elapsed, copied, total);
                        }
                        // Live error display
                        if (errors > 0 && el.dicomSortErrors) {
                            el.dicomSortErrors.style.display = 'block';
                            el.dicomSortErrorsSummary.textContent = 'Errors (' + errors + ')';
                            el.dicomSortErrorsBody.innerHTML = errorLog
                                .map(e => '<div class="dicom-error-line">' + escHtml(e) + '</div>').join('');
                        }
                    }, maxCopy, excludedMods, requiredMods);

                const label = res.aborted ? 'Aborted' : 'Done';
                el.dicomSortProgressText.textContent =
                    label + ' — copied ' + res.copied + '/' + res.total +
                    (res.errors ? ' (' + res.errors + ' errors)' : '') +
                    ' in ' + ((performance.now() - sortStart) / 1000).toFixed(1) + 's';
                if (el.dicomSortProgressETA) el.dicomSortProgressETA.textContent = '';

                // Final error display
                if (res.errors && el.dicomSortErrors) {
                    el.dicomSortErrors.style.display = 'block';
                    el.dicomSortErrorsSummary.textContent = 'Errors (' + res.errors + ')';
                    el.dicomSortErrorsBody.innerHTML = res.errorLog
                        .map(e => '<div class="dicom-error-line">' + escHtml(e) + '</div>').join('');
                }

                // Write error log to output folder
                if (res.errorLog.length && targetDirHandle) {
                    try {
                        const errFile = await targetDirHandle.getFileHandle('sort-errors.txt', { create: true });
                        const w = await errFile.createWritable();
                        const header = 'DICOM Sort Error Log — ' + new Date().toISOString() + '\n' +
                            'Copied: ' + res.copied + '/' + res.total + '\n' +
                            'Errors: ' + res.errors + '\n\n';
                        await w.write(header + res.errorLog.join('\n'));
                        await w.close();
                    } catch (ex) {
                        console.error('Could not write error log', ex);
                    }
                }

                // Show last N log entries
                el.dicomSortLog.innerHTML = res.log.slice(-100)
                    .map(l => '<div class="dicom-log-line">' + escHtml(l) + '</div>').join('');
            } catch (e) {
                console.error('Sort error', e);
                el.dicomSortProgressText.textContent = 'Error: ' + e.message;
            } finally {
                el.dicomSortBtn.disabled = false;
                el.dicomSortPauseBtn.style.display = 'none';
                el.dicomSortAbortBtn.style.display = 'none';
            }
        });
    }

    // ─────────────────────────────────────────────────────────────────────────
    // INIT
    // ─────────────────────────────────────────────────────────────────────────

    function init() {
        cacheElements();
        renderOptionalTags();
        setup();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
