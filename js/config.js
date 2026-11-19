// Rôle de chaque appareil dans le dashboard.
// Uniquement des identifiants Homey opaques : les noms sont lus en direct dans la Homey.
// Une clé d'accès est indispensable pour en tirer quoi que ce soit.

export const CONFIG = {
  meteo: {
    exterieur: '140c4a81-3c91-4f97-84fa-87fa6ab134b2',
    vent: '41e89a3e-2470-49d3-8d4e-9573a98f937c',
    pluie: '127aeadd-6ae5-4a96-ab03-630719bcb7ef',
    station: '7b6b4fe5-5e7e-4343-8ded-226ed823d771',
  },

  chauffage: {
    gainable: '576a45db-d201-44c1-893a-11d09c421ca6',
    // thermostat de zone + flow "Bascule Manuel/Programme" correspondant
    zones: [
      { id: 'fb13ee94-cad0-40b4-a122-258564e02130', zone: 'vie', bascule: 'b6d97547-84aa-487b-8198-e78dd7caddc0' },
      { id: '6e110189-ca61-40ee-a419-695254ed9569', zone: 'vie', bascule: '6a5a8c65-b0f4-4757-8330-0bafd0c9267e' },
      { id: '3830c311-5991-4b62-8208-07d7037d12ee', zone: 'nuit', bascule: 'ceedf0d1-9f33-42d9-8d78-b239ef7ea93a', co2: 'aee26f19-49d3-44f0-9076-a75ce7ea95ff' },
      { id: '734431e3-38bc-4030-b581-24e5190b9c43', zone: 'nuit', bascule: 'cddafe50-76ef-4a57-9be3-f9389a447df5', co2: 'cda794ee-78bf-433a-bd47-7c53c1c1d861' },
      { id: '2edb79d0-9c3d-400f-804b-6a7765b55204', zone: 'nuit', bascule: '537889d7-b411-42dd-9ded-b02910b8e8a5', co2: 'aaa63c4c-ce55-4b4f-86d7-afca30fff096' },
      { id: '458de9c0-1460-4e1a-9e88-e8409dcf62b0', zone: 'nuit', bascule: 'f836c7a1-dc69-4fe9-a6f0-c5bd375b1e17' },
    ],
  },

  // Couleur de la pastille de température : bleu en dessous de min, vert de min à max, rouge au-dessus
  seuils: {
    chauffage: { nuit: [17, 20], vie: [20, 22] },
    clim: [22, 25],
  },

  energie: {
    linky: '2b5e38d3-bcbf-45fb-9d31-f82db13b37df',
    solaire: '65836992-eedc-43dc-8ebc-79ce0be177e7',
    compteur: '586f5281-61d3-4a8d-96cc-47d2ce42050d',
  },

  volets: {
    vie: {
      groupe: 'bd947eee-bc20-42a2-baa8-96ac7fe14b97',
      items: [
        'c602b7f7-3599-42be-9fc4-c8a6d42ffdad',
        '1aa02cea-d4cd-4aee-b401-59400cb11cf5',
        'bbd79253-c1fc-4593-aaa6-6774d170b53b',
        '1b17b414-cbf7-4889-977e-9a77be29330c',
      ],
    },
    nuit: {
      groupe: 'eee7a9eb-ed0b-4d2e-ab6e-499ebbee3cca',
      items: [
        '07e3d847-d0cf-4b99-bec9-a715f328975c',
        '7f486c44-9ed9-49f3-af22-14c7f8acfa27',
        '9d48d84e-def3-4e52-881d-1b1c4144091e',
        'd0eec240-1e80-48f0-b171-ae1f38698ddc',
      ],
    },
  },

  // Pièces sans volet rattachées à une zone (les autres sont déduites des volets)
  piecesZone: {
    vie: [
      '140895f0-1a40-4e01-9f42-b1c54bf7b27a', // Entrée
      '131b328f-2414-4919-be78-157b384f0269', // Garage
      '8bd548f7-408f-4611-99e7-aa7a81ca8cd5', // Buanderie
    ],
    nuit: ['e95ba9f5-ec5b-4692-9c39-429f818a6f04'], // Salle de bain
  },

  portail: {
    relais: 'a564e932-4fae-4651-8681-0d397f721ddd', // impulsion : on, 1 s, off (comme le flow)
    capteur: 'b82d4c9b-5dac-41b2-8a4e-96ead6ef776f',
  },

  cameras: ['35f40034-1f6f-4207-8ff3-34795a6d32c9', '4277c191-56ec-4cfc-8c0f-89651aeac469'],

  presence: ['ebd39cb0-9b89-4547-af1d-b88cf2eb6b57', 'fce26290-c84d-4a79-b949-1cd30ea3dd3e'],

  alertes: {
    fumee: 'c8f12c60-0d9e-4d10-9aba-f1667e427106',
    baies: ['08283755-af8d-4779-ae32-2a3cede23b16', 'f75e9214-1be7-495b-bc33-c32893ef4896'],
    cameras: ['35f40034-1f6f-4207-8ff3-34795a6d32c9', '4277c191-56ec-4cfc-8c0f-89651aeac469'],
    portailMinutes: 10,
    co2: 1000,
    batterie: { faible: 10, urgente: 5 },
  },

  // Zones et appareils jamais affichés
  exclureZones: ['f3593f7b-5555-4a47-b295-0a2c6933f45a'],
  exclureAppareils: [
    'b02c4f78-e200-4b57-acdb-5ed3d462a5c7',
    'ca2e08ce-4e68-4a89-b9f3-d6017c88d627',
    'cf850cd0-4c98-460d-8c9a-2fc24b5dfea0',
    'a564e932-4fae-4651-8681-0d397f721ddd',
    '2267b787-c157-4039-acf5-c929e19e2693',
    '46ae7f02-27b6-4eb3-ab05-d5f55dfc14ba',
    '26175f79-5b72-4856-852c-eef6e6ad060c',
  ],

  // Page Consommation : le gainable est estimé par un appareil virtuel (masqué ailleurs)
  consoGainable: '26175f79-5b72-4856-852c-eef6e6ad060c',
  consoInclure: ['26175f79-5b72-4856-852c-eef6e6ad060c'],

  // Tuiles de consommation : vert sous 150 W, orange de 150 à 800 W, rouge au-dessus (en watts)
  seuilsConso: [150, 800],

  // Pièces masquées sur la page Éclairage
  eclairageExclureZones: ['121d71a3-6e2b-4e1f-8b95-5f5e7ebc5cf4'], // Spare

  // Prises à confirmer avant de couper
  prisesProtegees: [
    '80c2702f-cebb-4e98-8736-c78e701590ce',
    '710e90ca-ba66-4e64-9dc1-697596bf6d4b',
    'bc12b969-2c63-4989-9602-223895c30c2e',
    '535d8ce2-c2c8-43ae-8aa6-9a771ca50e19',
    '6b572267-0ecb-42aa-a2bc-0b0c9d0d5bbc',
  ],
  classesPrises: ['socket', 'tv', 'fan', 'washer', 'dishwasher'],
};

export const DEFAUTS = {
  homeyUrl: '',
  cle: '',
  prixKwh: 0.1927,
  aboMois: 19.56,
  coefFHE: 1.04,
  iconStyle: 'line',
  theme: 'auto',
  commune: '',
  favoris: [],
  lat: null,
  lon: null,
  reveil: false,
  reveilCapteur: '',
  avatars: {},
};
