export type Field = {
  key: string;
  label: string;
  kind: 'select' | 'number';
  values?: [string, string | boolean][];
  unit?: string;
  hint?: string;
};

const enabled: [string, boolean][] = [['Отключено', false], ['Включено', true]];
export const sections: {name: string; groups: {title: string; fields: Field[]}[]}[] = [
  {name: 'Режим', groups: [{title: '', fields: [
    {key: 'separator_preset', label: 'Пресет', kind: 'select', values: [
      ['Инструментал: полный','instrumental_full'], ['Инструментал: сбалансированный','instrumental_balanced'],
      ['Инструментал: чистый','instrumental_clean'], ['Инструментал: экономный','instrumental_low_resource'],
      ['Караоке','karaoke'], ['Вокал: сбалансированный','vocal_balanced'],
      ['Вокал: чистый','vocal_clean'], ['Вокал: полный','vocal_full'], ['Вокал: RVC','vocal_rvc'],
    ], hint: 'Полный режим: максимально сохраняет музыку и звуковые эффекты.'},
    {key: 'precision',label:'Точность',kind:'select',values:[['FP32 (максимальная точность)','fp32'],['Автовыбор (autocast)','autocast'],['FP16 (ускоренный)','native_fp16']]},
    {key: 'torch_compile',label:'Компиляция PyTorch',kind:'select',values:enabled, hint:'Ускорение повторных запусков'},
  ]}]},
  {name: 'Постобработка',groups:[
    {title:'',fields:[
      {key:'post_profile',label:'Профиль',kind:'select',values:[['Отключено','off'],['Бережная','safe'],['Восстановление','restoration'],['Свои настройки','custom']],hint:'По умолчанию эффекты отключены, но преобразование формата применяется.'},
      {key:'highpass_enabled',label:'Фильтр высоких частот',kind:'select',values:enabled},
      {key:'highpass_hz',label:'Частота среза ФВЧ',kind:'number',unit:'Hz'},
    ]},
    {title:'Шумоподавление',fields:[
      {key:'denoise_mode',label:'Шумоподавление',kind:'select',values:[['Выключено','off'],['Авто','auto'],['Всегда','always']]},
      {key:'denoise_reduction_db',label:'Уровень подавления',kind:'number',unit:'dB'},
      {key:'noise_floor_threshold_db',label:'Минимальный порог',kind:'number',unit:'dBFS'},
      {key:'noise_flatness_threshold',label:'Порог плоскостности',kind:'number',unit:'0–1'},
    ]},
    {title:'',fields:[{key:'declick_enabled',label:'Удаление щелчков',kind:'select',values:enabled}]},
    {title:'Восстановление ВЧ',fields:[
      {key:'high_end_recovery',label:'Подмешать ВЧ оригинала',kind:'select',values:enabled},
      {key:'high_end_cutoff_hz',label:'Отрезать ВЧ',kind:'number',unit:'Hz'},
      {key:'high_end_gain_db',label:'Громкость ВЧ',kind:'number',unit:'dB'},
    ]},
  ]},
  {name:'Фильтры',groups:[
    {title:'Нормализация',fields:[
      {key:'loudnorm_enabled',label:'Нормализация',kind:'select',values:enabled},
      {key:'target_lufs',label:'Целевая громкость (LUFS)',kind:'number'},
      {key:'target_lra',label:'Диапазон громкости (LRA)',kind:'number'},
      {key:'true_peak_db',label:'Истинный пиковый уровень',kind:'number',unit:'dBTP'},
    ]},
    {title:'Компрессор',fields:[
      {key:'compressor_enabled',label:'Компрессор',kind:'select',values:enabled},
      {key:'compressor_threshold_db',label:'Порог',kind:'number',unit:'dB'},
      {key:'compressor_ratio',label:'Степень сжатия',kind:'number'},
      {key:'compressor_attack_ms',label:'Атака',kind:'number',unit:'мс'},
      {key:'compressor_release_ms',label:'Восстановление',kind:'number',unit:'мс'},
    ]},
    {title:'Лимитер',fields:[
      {key:'limiter_enabled',label:'Лимитер',kind:'select',values:enabled},
      {key:'limiter_limit',label:'Лимит',kind:'number',unit:'0–1'},
    ]},
  ]},
];
